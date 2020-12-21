const _ = require('lodash');
const { get } = require('axios');
const Koa = require('koa');
const Router = require('koa-router');
const NodeCache = require('node-cache');
const Jsonstorage = require('./src/jsonstorage');

const app = new Koa();
const router = new Router();
const illustCache = new NodeCache({ stdTTL: 600, checkperiod: 60, useClones: false });

const { PROTOCOL } = process.env;
const PORT = process.env.PORT || 8080;

let uploadTimeout = null;
let analytics = {
  startTime: Date.now(),
  requestNum: 0,
  bandwidth: 0,
};

if (Jsonstorage.enable()) {
  Jsonstorage.get()
    .then(data => {
      Object.assign(analytics, _.pick(data, Object.keys(analytics)));
      analytics = _.mapValues(analytics, v => parseInt(v) || 0);
      if (!analytics.startTime) analytics.startTime = Date.now();
      analytics = new Proxy(analytics, {
        set(...args) {
          if (!uploadTimeout) {
            uploadTimeout = setTimeout(() => {
              uploadTimeout = null;
              Jsonstorage.put(analytics).catch(() => console.error('update jsonstorage error'));
            }, 60 * 1000);
          }
          return Reflect.set(...args);
        },
      });
      console.log('jsonstorage loaded');
    })
    .catch(() => console.error('get jsonstorage error'));
}

const index = require('./pages/index');

const pHeaders = {
  Referer: 'https://www.pixiv.net',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.113 Safari/537.36',
};

const reverseProxy = async (ctx, path, okCb) => {
  const { data, status, headers } = await get(path, {
    baseURL: 'https://i-cf.pximg.net',
    headers: pHeaders,
    responseType: 'stream',
    validateStatus: () => true,
  });
  ctx.status = status;
  ['content-type', 'content-length'].forEach(k => headers[k] && ctx.set(k, headers[k]));
  if (status == 200) {
    analytics.requestNum++;
    analytics.bandwidth += parseInt(headers['content-length']) || 0;
    ctx.body = data;
    ['last-modified', 'expires', 'cache-control'].forEach(k => headers[k] && ctx.set(k, headers[k]));
    if (typeof okCb === 'function') okCb();
  } else ctx.set('cache-control', 'max-age=3600');
};

router
  .get('/', ctx => {
    const baseURL = (() => {
      if (PROTOCOL) ctx.URL.protocol = PROTOCOL;
      const paths = ctx.URL.href.split('/');
      paths.pop();
      return paths.join('/');
    })();
    ctx.set('cache-control', 'no-cache');
    ctx.body = index({
      baseURL,
      uptime: Date.now() - analytics.startTime,
      requestNum: analytics.requestNum,
      bandwidth: analytics.bandwidth,
    });
  })
  .get('/favicon.ico', ctx => {
    return get('https://www.pixiv.net/favicon.ico', {
      headers: pHeaders,
      responseType: 'stream',
    })
      .then(({ data, status, headers }) => {
        ctx.body = data;
        ctx.status = status;
        ctx.set('cache-control', 'max-age=604800');
        ['content-length', 'content-type', 'last-modified'].forEach(k => headers[k] && ctx.set(k, headers[k]));
      })
      .catch(() => {
        ctx.status = 502;
      });
  })
  .get(/^(?:\/(mini|original|regular|small|thumb))?\/(\d+)(?:\/(\d+))?/, async ctx => {
    const { 0: size = 'original', 1: pid, 2: p = 0 } = ctx.params;
    let urls = illustCache.get(pid);
    if (!urls) {
      const {
        data: { error, message, body },
        status,
      } = await get(`https://www.pixiv.net/ajax/illust/${pid}`, {
        headers: pHeaders,
        validateStatus: () => true,
      });
      if (error) {
        ctx.body = message;
        ctx.status = status;
        ctx.set('cache-control', 'no-cache');
        return;
      }
      urls = body.urls;
      illustCache.set(pid, urls);
    }
    const path = new URL(urls[size].replace('_p0', `_p${p}`)).pathname;
    const paths = path.split('/');
    const filename = paths[paths.length - 1];
    return reverseProxy(ctx, path, () => ctx.set('content-disposition', `filename="${filename}"`));
  })
  .get(/.*/, ctx => reverseProxy(ctx, ctx.path));

app.use(router.routes()).use(router.allowedMethods()).listen(PORT);

console.log(`Server is running at http://localhost:${PORT}`);
