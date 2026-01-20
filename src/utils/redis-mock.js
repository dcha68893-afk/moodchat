// src/utils/redis-mock.js (or src/config/redis-mock.js)
class RedisMock {
  constructor() {
    this.connected = false;
    this.data = new Map();
    console.log('✅ RedisMock initialized (in-memory mode)');
  }

  async connect() {
    this.connected = true;
    console.log('Mock Redis connected (in-memory mode)');
    return this;
  }

  async get(key) {
    console.log(`Mock GET: ${key}`);
    return this.data.get(key) || null;
  }

  async set(key, value, options = {}) {
    console.log(`Mock SET: ${key} = ${value}`);
    this.data.set(key, value);
    
    if (options.EX) {
      // Simulate expiry
      setTimeout(() => {
        this.data.delete(key);
      }, options.EX * 1000);
    }
    
    return 'OK';
  }

  async del(key) {
    console.log(`Mock DEL: ${key}`);
    this.data.delete(key);
    return 1;
  }

  async exists(key) {
    return this.data.has(key) ? 1 : 0;
  }

  async ping() {
    return 'PONG';
  }

  on(event, callback) {
    if (event === 'connect' && this.connected) {
      callback();
    }
    return this;
  }

  async quit() {
    this.connected = false;
    this.data.clear();
    console.log('Mock Redis disconnected');
    return 'OK';
  }

  async disconnect() {
    return this.quit();
  }

  getStatus() {
    return { 
      connected: this.connected, 
      mode: 'mock',
      keys: this.data.size
    };
  }

  // Additional mock methods
  async keys(pattern) {
    const allKeys = Array.from(this.data.keys());
    if (pattern === '*') return allKeys;
    
    // Simple pattern matching
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return allKeys.filter(key => regex.test(key));
  }

  async incr(key) {
    const current = parseInt(this.data.get(key) || '0');
    const newValue = current + 1;
    this.data.set(key, newValue.toString());
    return newValue;
  }

  async expire(key, seconds) {
    if (this.data.has(key)) {
      setTimeout(() => {
        this.data.delete(key);
      }, seconds * 1000);
      return 1;
    }
    return 0;
  }
}

// Create and export instance
const redisMock = new RedisMock();

// Export both instance and class
module.exports = redisMock;
module.exports.RedisMock = RedisMock;