// test-redis.js
const Redis = require("ioredis");

const redis = new Redis({
  host: "redis-54378.c12.us-east-1.redis.render.com",
  port: 6379,
  password: "b055688a190e7cba9f827b41a06df3d0",
  tls: {}, // important! enables TLS
});

redis.on("connect", () => console.log("✅ Redis connected successfully"));
redis.on("error", (err) => console.error("❌ Redis connection error:", err));

(async () => {
  try {
    await redis.set("test-key", "hello");
    const value = await redis.get("test-key");
    console.log("📌 Test key value:", value); // should print "hello"
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
