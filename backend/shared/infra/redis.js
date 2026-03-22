import { Redis } from '@upstash/redis';

let redis = null;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const isPlaceholder = (val) => !val || val.includes('your-') || val.includes('AIza...') || val.includes('EAAG...');

if (url && token && !isPlaceholder(url) && !isPlaceholder(token)) {
  redis = new Redis({
    url,
    token,
  });
}

export { redis };
