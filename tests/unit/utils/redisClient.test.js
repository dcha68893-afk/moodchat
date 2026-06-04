const redisClient = require('../../../src/utils/redisClient');

// Mock Redis client
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    set: jest.fn(),
    get: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
    exists: jest.fn(),
    hset: jest.fn(),
    hget: jest.fn(),
    hgetall: jest.fn(),
    sadd: jest.fn(),
    smembers: jest.fn(),
    srem: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    on: jest.fn(),
    quit: jest.fn(),
    disconnect: jest.fn()
  }));
});

describe('Redis Client', () => {
  let mockRedis;

  beforeEach(() => {
    // Get the mocked instance
    mockRedis = redisClient.getClient();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await redisClient.disconnect();
  });

  describe('Basic Operations', () => {
    test('should set and get value', async () => {
      mockRedis.set.mockResolvedValue('OK');
      mockRedis.get.mockResolvedValue('test-value');

      await redisClient.set('test-key', 'test-value', 3600);
      const result = await redisClient.get('test-key');

      expect(mockRedis.set).toHaveBeenCalledWith('test-key', 'test-value', 'EX', 3600);
      expect(result).toBe('test-value');
    });

    test('should delete key', async () => {
      mockRedis.del.mockResolvedValue(1);

      const result = await redisClient.delete('test-key');
      expect(mockRedis.del).toHaveBeenCalledWith('test-key');
      expect(result).toBe(1);
    });

    test('should check key existence', async () => {
      mockRedis.exists.mockResolvedValue(1);

      const result = await redisClient.exists('test-key');
      expect(result).toBe(true);
    });
  });

  describe('Hash Operations', () => {
    test('should set hash field', async () => {
      mockRedis.hset.mockResolvedValue(1);

      await redisClient.hset('user:123', 'name', 'John');
      expect(mockRedis.hset).toHaveBeenCalledWith('user:123', 'name', 'John');
    });

    test('should get hash field', async () => {
      mockRedis.hget.mockResolvedValue('John');

      const result = await redisClient.hget('user:123', 'name');
      expect(result).toBe('John');
    });

    test('should get all hash fields', async () => {
      mockRedis.hgetall.mockResolvedValue({ name: 'John', age: '30' });

      const result = await redisClient.hgetall('user:123');
      expect(result).toEqual({ name: 'John', age: '30' });
    });
  });

  describe('Set Operations', () => {
    test('should add to set', async () => {
      mockRedis.sadd.mockResolvedValue(1);

      await redisClient.sadd('online-users', 'user-123');
      expect(mockRedis.sadd).toHaveBeenCalledWith('online-users', 'user-123');
    });

    test('should get set members', async () => {
      mockRedis.smembers.mockResolvedValue(['user-123', 'user-456']);

      const result = await redisClient.smembers('online-users');
      expect(result).toEqual(['user-123', 'user-456']);
    });

    test('should remove from set', async () => {
      mockRedis.srem.mockResolvedValue(1);

      await redisClient.srem('online-users', 'user-123');
      expect(mockRedis.srem).toHaveBeenCalledWith('online-users', 'user-123');
    });
  });

  describe('Pub/Sub', () => {
    test('should publish message', async () => {
      mockRedis.publish.mockResolvedValue(1);

      await redisClient.publish('channel', 'message');
      expect(mockRedis.publish).toHaveBeenCalledWith('channel', 'message');
    });
  });

  describe('Error Handling', () => {
    test('should handle connection errors', async () => {
      mockRedis.get.mockRejectedValue(new Error('Connection failed'));

      await expect(redisClient.get('test-key')).rejects.toThrow('Connection failed');
    });

    test('should handle missing keys', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await redisClient.get('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('Utility Methods', () => {
    test('should set with JSON serialization', async () => {
      mockRedis.set.mockResolvedValue('OK');

      const data = { name: 'John', age: 30 };
      await redisClient.setJson('user:123', data, 3600);

      expect(mockRedis.set).toHaveBeenCalledWith(
        'user:123',
        JSON.stringify(data),
        'EX',
        3600
      );
    });

    test('should get with JSON parsing', async () => {
      const data = { name: 'John', age: 30 };
      mockRedis.get.mockResolvedValue(JSON.stringify(data));

      const result = await redisClient.getJson('user:123');
      expect(result).toEqual(data);
    });

    test('should return null for invalid JSON', async () => {
      mockRedis.get.mockResolvedValue('invalid-json');

      const result = await redisClient.getJson('user:123');
      expect(result).toBeNull();
    });
  });
});