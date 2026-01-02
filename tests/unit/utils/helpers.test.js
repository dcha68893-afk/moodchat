const {
  generateRandomString,
  formatCurrency,
  capitalizeFirst,
  debounce,
  throttle,
  deepClone,
  isEmpty,
  groupBy,
  chunkArray,
  sleep,
  retry
} = require('../../../src/utils/helpers');

describe('Helpers Utility', () => {
  describe('generateRandomString', () => {
    test('should generate string of correct length', () => {
      const result = generateRandomString(10);
      expect(result).toHaveLength(10);
      expect(typeof result).toBe('string');
    });

    test('should generate different strings', () => {
      const str1 = generateRandomString(10);
      const str2 = generateRandomString(10);
      expect(str1).not.toBe(str2);
    });

    test('should handle edge cases', () => {
      expect(generateRandomString(0)).toBe('');
      expect(() => generateRandomString(-1)).toThrow();
    });
  });

  describe('formatCurrency', () => {
    test('should format numbers as currency', () => {
      expect(formatCurrency(1000)).toBe('$1,000.00');
      expect(formatCurrency(1234.56)).toBe('$1,234.56');
      expect(formatCurrency(0)).toBe('$0.00');
    });

    test('should handle negative numbers', () => {
      expect(formatCurrency(-1000)).toBe('-$1,000.00');
    });

    test('should accept custom locales', () => {
      expect(formatCurrency(1000, 'EUR')).toBe('€1,000.00');
    });
  });

  describe('capitalizeFirst', () => {
    test('should capitalize first letter', () => {
      expect(capitalizeFirst('hello')).toBe('Hello');
      expect(capitalizeFirst('HELLO')).toBe('HELLO');
      expect(capitalizeFirst('')).toBe('');
    });

    test('should handle edge cases', () => {
      expect(capitalizeFirst('a')).toBe('A');
      expect(capitalizeFirst('123abc')).toBe('123abc');
    });
  });

  describe('debounce', () => {
    jest.useFakeTimers();

    test('should debounce function calls', () => {
      const mockFn = jest.fn();
      const debouncedFn = debounce(mockFn, 100);

      debouncedFn();
      debouncedFn();
      debouncedFn();

      expect(mockFn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttle', () => {
    jest.useFakeTimers();

    test('should throttle function calls', () => {
      const mockFn = jest.fn();
      const throttledFn = throttle(mockFn, 100);

      throttledFn();
      throttledFn();
      throttledFn();

      expect(mockFn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(100);
      throttledFn();
      expect(mockFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('deepClone', () => {
    test('should create deep clone of objects', () => {
      const original = { a: 1, b: { c: 2 } };
      const clone = deepClone(original);

      clone.b.c = 3;
      expect(original.b.c).toBe(2);
    });

    test('should clone arrays and nested structures', () => {
      const original = [{ a: 1 }, { b: 2 }];
      const clone = deepClone(original);

      clone[0].a = 99;
      expect(original[0].a).toBe(1);
    });
  });

  describe('isEmpty', () => {
    test('should check if value is empty', () => {
      expect(isEmpty({})).toBe(true);
      expect(isEmpty([])).toBe(true);
      expect(isEmpty('')).toBe(true);
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);

      expect(isEmpty({ a: 1 })).toBe(false);
      expect(isEmpty([1])).toBe(false);
      expect(isEmpty('text')).toBe(false);
    });
  });

  describe('groupBy', () => {
    test('should group array by key', () => {
      const users = [
        { id: 1, group: 'A' },
        { id: 2, group: 'B' },
        { id: 3, group: 'A' }
      ];

      const grouped = groupBy(users, 'group');
      expect(grouped.A).toHaveLength(2);
      expect(grouped.B).toHaveLength(1);
    });

    test('should handle empty arrays', () => {
      expect(groupBy([], 'key')).toEqual({});
    });
  });

  describe('chunkArray', () => {
    test('should chunk array correctly', () => {
      const array = [1, 2, 3, 4, 5];
      const chunks = chunkArray(array, 2);

      expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
      expect(chunks).toHaveLength(3);
    });

    test('should handle edge cases', () => {
      expect(chunkArray([], 2)).toEqual([]);
      expect(chunkArray([1], 5)).toEqual([[1]]);
    });
  });

  describe('sleep', () => {
    jest.useFakeTimers();

    test('should sleep for specified time', async () => {
      const sleepPromise = sleep(100);
      jest.advanceTimersByTime(100);
      await expect(sleepPromise).resolves.toBeUndefined();
    });
  });

  describe('retry', () => {
    test('should retry failed operations', async () => {
      let attempts = 0;
      const failingFn = async () => {
        attempts++;
        if (attempts < 3) throw new Error('Failed');
        return 'success';
      };

      const result = await retry(failingFn, { retries: 3, delay: 10 });
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    test('should throw after max retries', async () => {
      const alwaysFailing = async () => {
        throw new Error('Always fails');
      };

      await expect(
        retry(alwaysFailing, { retries: 2, delay: 10 })
      ).rejects.toThrow('Always fails');
    });
  });
});