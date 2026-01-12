// Put this in src/utils/redis-mock.js
console.log('✅ Using mock Redis (in-memory) - No Redis server needed');

module.exports = {
  isConnected: true,
  
  async connect() {
    console.log('Mock Redis connected (in-memory mode)');
    return this;
  },
  
  async get(key) {
    console.log(`Mock GET: ${key}`);
    return null;
  },
  
  async set(key, value) {
    console.log(`Mock SET: ${key} = ${value}`);
    return 'OK';
  },
  
  async ping() {
    return 'PONG';
  },
  
  on() {
    // Ignore all events
    return this;
  },
  
  getStatus() {
    return { connected: true, mode: 'mock' };
  }
};