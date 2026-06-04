const fileUpload = require('../../../src/utils/fileUpload');
const path = require('path');
const fs = require('fs').promises;

// Mock dependencies
jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    access: jest.fn(),
    unlink: jest.fn()
  }
}));

jest.mock('multer', () => {
  const multer = () => ({
    single: jest.fn(),
    array: jest.fn(),
    fields: jest.fn()
  });
  
  multer.diskStorage = jest.fn();
  return multer;
});

describe('File Upload Utility', () => {
  const mockFile = {
    originalname: 'test.jpg',
    buffer: Buffer.from('test'),
    mimetype: 'image/jpeg',
    size: 1024
  };

  describe('validateFile', () => {
    test('should validate file type and size', () => {
      expect(fileUpload.validateFile(mockFile, ['image/jpeg'], 5000)).toBe(true);
      expect(fileUpload.validateFile(mockFile, ['image/png'], 5000)).toBe(false);
      expect(fileUpload.validateFile({ ...mockFile, size: 6000 }, ['image/jpeg'], 5000)).toBe(false);
    });

    test('should handle invalid file object', () => {
      expect(fileUpload.validateFile(null, ['image/jpeg'], 5000)).toBe(false);
      expect(fileUpload.validateFile({}, ['image/jpeg'], 5000)).toBe(false);
    });
  });

  describe('generateFileName', () => {
    test('should generate unique filename', () => {
      const filename = fileUpload.generateFileName('test.jpg');
      expect(filename).toMatch(/^[\w-]+\.jpg$/);
    });

    test('should handle files without extension', () => {
      const filename = fileUpload.generateFileName('test');
      expect(filename).toMatch(/^[\w-]+$/);
    });
  });

  describe('getFileExtension', () => {
    test('should extract file extension', () => {
      expect(fileUpload.getFileExtension('test.jpg')).toBe('.jpg');
      expect(fileUpload.getFileExtension('test.min.js')).toBe('.js');
      expect(fileUpload.getFileExtension('noextension')).toBe('');
      expect(fileUpload.getFileExtension('.gitignore')).toBe('');
    });
  });

  describe('createUploadDirectory', () => {
    test('should create directory if not exists', async () => {
      const fs = require('fs').promises;
      fs.access.mockRejectedValue(new Error('Not exists'));
      fs.mkdir.mockResolvedValue();

      await fileUpload.createUploadDirectory('/test/path');
      
      expect(fs.mkdir).toHaveBeenCalledWith('/test/path', { recursive: true });
    });

    test('should not create directory if exists', async () => {
      const fs = require('fs').promises;
      fs.access.mockResolvedValue();
      
      await fileUpload.createUploadDirectory('/test/path');
      expect(fs.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('removeFile', () => {
    test('should remove file successfully', async () => {
      const fs = require('fs').promises;
      fs.unlink.mockResolvedValue();

      await expect(fileUpload.removeFile('/path/to/file.jpg')).resolves.not.toThrow();
    });

    test('should handle file not found', async () => {
      const fs = require('fs').promises;
      fs.unlink.mockRejectedValue({ code: 'ENOENT' });

      await expect(fileUpload.removeFile('/path/to/nonexistent.jpg')).resolves.toBe(false);
    });

    test('should propagate other errors', async () => {
      const fs = require('fs').promises;
      fs.unlink.mockRejectedValue(new Error('Permission denied'));

      await expect(fileUpload.removeFile('/path/to/file.jpg')).rejects.toThrow('Permission denied');
    });
  });

  describe('getFileSize', () => {
    test('should format file sizes', () => {
      expect(fileUpload.getFileSize(500)).toBe('500 Bytes');
      expect(fileUpload.getFileSize(1500)).toBe('1.46 KB');
      expect(fileUpload.getFileSize(1500000)).toBe('1.43 MB');
      expect(fileUpload.getFileSize(1500000000)).toBe('1.4 GB');
    });
  });

  describe('isImageFile', () => {
    test('should detect image files', () => {
      expect(fileUpload.isImageFile('image.jpg')).toBe(true);
      expect(fileUpload.isImageFile('photo.png')).toBe(true);
      expect(fileUpload.isImageFile('document.pdf')).toBe(false);
      expect(fileUpload.isImageFile('')).toBe(false);
    });
  });

  describe('isDocumentFile', () => {
    test('should detect document files', () => {
      expect(fileUpload.isDocumentFile('document.pdf')).toBe(true);
      expect(fileUpload.isDocumentFile('report.docx')).toBe(true);
      expect(fileUpload.isDocumentFile('image.jpg')).toBe(false);
    });
  });

  describe('getAllowedExtensions', () => {
    test('should return allowed extensions for type', () => {
      expect(fileUpload.getAllowedExtensions('image')).toContain('.jpg');
      expect(fileUpload.getAllowedExtensions('document')).toContain('.pdf');
      expect(fileUpload.getAllowedExtensions('video')).toContain('.mp4');
      expect(fileUpload.getAllowedExtensions('unknown')).toEqual([]);
    });
  });

  describe('validateFileName', () => {
    test('should validate filename safety', () => {
      expect(fileUpload.validateFileName('safe-name.jpg')).toBe(true);
      expect(fileUpload.validateFileName('../evil.jpg')).toBe(false);
      expect(fileUpload.validateFileName('../../etc/passwd')).toBe(false);
      expect(fileUpload.validateFileName('')).toBe(false);
      expect(fileUpload.validateFileName(null)).toBe(false);
    });
  });

  describe('upload middleware', () => {
    test('should create upload middleware with options', () => {
      const middleware = fileUpload.createUploadMiddleware({
        fieldName: 'file',
        maxSize: 5 * 1024 * 1024,
        allowedTypes: ['image/jpeg', 'image/png']
      });

      expect(middleware).toBeDefined();
    });
  });
});