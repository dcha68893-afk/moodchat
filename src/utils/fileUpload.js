const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');
const logger = require('./logger');

class FileUpload {
  constructor() {
    this.uploadPath = config.upload.uploadPath;
    this.ensureUploadDirectory();
  }

  /**
   * Ensure upload directory exists
   */
  ensureUploadDirectory() {
    if (!fs.existsSync(this.uploadPath)) {
      fs.mkdirSync(this.uploadPath, { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'images'), { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'videos'), { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'audio'), { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'documents'), { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'avatars'), { recursive: true });
    }
  }

  /**
   * Configure multer storage
   */
  getStorage(destination = null) {
    return multer.diskStorage({
      destination: (req, file, cb) => {
        let uploadDir = destination || this.uploadPath;

        // Organize by file type
        if (file.mimetype.startsWith('image/')) {
          uploadDir = path.join(uploadDir, 'images');
        } else if (file.mimetype.startsWith('video/')) {
          uploadDir = path.join(uploadDir, 'videos');
        } else if (file.mimetype.startsWith('audio/')) {
          uploadDir = path.join(uploadDir, 'audio');
        } else {
          uploadDir = path.join(uploadDir, 'documents');
        }

        // Ensure directory exists
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = path.extname(file.originalname);
        const filename = file.fieldname + '-' + uniqueSuffix + ext;
        cb(null, filename);
      },
    });
  }

  /**
   * File filter for multer
   */
  fileFilter(req, file, cb) {
    const allowedTypes = [
      ...config.upload.allowedImageTypes,
      ...config.upload.allowedVideoTypes,
      ...config.upload.allowedAudioTypes,
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: ' + allowedTypes.join(', ')), false);
    }
  }

  /**
   * Get multer instance with configuration
   */
  getMulter(options = {}) {
    const storage = options.storage || this.getStorage(options.destination);
    const fileFilter = options.fileFilter || this.fileFilter.bind(this);
    const limits = options.limits || {
      fileSize: config.upload.maxFileSize,
    };

    return multer({
      storage,
      fileFilter,
      limits,
    });
  }

  /**
   * Upload a single file
   */
  async uploadFile(file, options = {}) {
    try {
      const result = {
        originalname: file.originalname,
        filename: file.filename,
        path: file.path,
        size: file.size,
        mimetype: file.mimetype,
        url: this.getFileUrl(file),
        type: this.getFileType(file.mimetype),
      };

      // Process image if needed
      if (result.type === 'image' && options.processImage !== false) {
        await this.processImage(file, options);

        // Add dimensions if available
        const dimensions = await this.getImageDimensions(file.path);
        if (dimensions) {
          result.dimensions = dimensions;
        }

        // Generate thumbnail if requested
        if (options.generateThumbnail) {
          const thumbnail = await this.generateThumbnail(file.path, options);
          if (thumbnail) {
            result.thumbnailUrl = thumbnail.url;
            result.thumbnailPath = thumbnail.path;
          }
        }

        // Compress if requested
        if (options.compress) {
          const compressed = await this.compressImage(file.path, options);
          if (compressed) {
            result.url = compressed.url;
            result.path = compressed.path;
            result.size = compressed.size;
            result.isCompressed = true;
            result.compressionQuality = options.quality || 80;
          }
        }
      }

      // Get duration for audio/video
      if (['video', 'audio'].includes(result.type)) {
        const duration = await this.getMediaDuration(file.path);
        if (duration) {
          result.duration = duration;
        }
      }

      logger.info('File uploaded successfully:', {
        filename: result.filename,
        type: result.type,
        size: result.size,
      });

      return result;
    } catch (error) {
      logger.error('File upload error:', error);

      // Clean up uploaded file if there was an error
      if (file && file.path) {
        this.deleteFile(file.path).catch(() => {});
      }

      throw error;
    }
  }

  /**
   * Upload multiple files
   */
  async uploadFiles(files, options = {}) {
    const results = [];

    for (const file of files) {
      try {
        const result = await this.uploadFile(file, options);
        results.push(result);
      } catch (error) {
        logger.error('Error uploading file:', error);
        results.push({
          originalname: file.originalname,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Process image (resize, format conversion, etc.)
   */
  async processImage(file, options = {}) {
    try {
      const image = sharp(file.path);
      const metadata = await image.metadata();

      // Apply transformations
      if (options.resize) {
        const { width, height, fit = 'cover' } = options.resize;
        image.resize(width, height, { fit });
      }

      if (options.format) {
        image.toFormat(options.format, {
          quality: options.quality || 80,
        });
      }

      // Apply additional transformations
      if (options.rotate) {
        image.rotate(options.rotate);
      }

      if (options.blur) {
        image.blur(options.blur);
      }

      if (options.grayscale) {
        image.grayscale();
      }

      // Save processed image
      const outputPath = file.path.replace(
        path.extname(file.path),
        `_processed${path.extname(file.path)}`
      );

      await image.toFile(outputPath);

      // Replace original with processed
      fs.unlinkSync(file.path);
      fs.renameSync(outputPath, file.path);

      logger.info('Image processed successfully:', {
        filename: file.filename,
        transformations: Object.keys(options).filter(
          k => k !== 'generateThumbnail' && k !== 'compress'
        ),
      });

      return true;
    } catch (error) {
      logger.error('Image processing error:', error);
      throw error;
    }
  }

  /**
   * Generate thumbnail for image or video
   */
  async generateThumbnail(filePath, options = {}) {
    try {
      const ext = path.extname(filePath);
      const thumbnailPath = filePath.replace(ext, '_thumb.jpg');

      // For images
      if (filePath.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
        await sharp(filePath)
          .resize(options.thumbnailWidth || 200, options.thumbnailHeight || 200, {
            fit: 'cover',
            position: 'center',
          })
          .jpeg({ quality: options.thumbnailQuality || 70 })
          .toFile(thumbnailPath);

        return {
          path: thumbnailPath,
          url: this.getFileUrl({ path: thumbnailPath }),
        };
      }

      // For videos, you would need a video processing library like ffmpeg
      // This is a placeholder implementation
      if (filePath.match(/\.(mp4|mov|avi|webm)$/i)) {
        logger.warn('Video thumbnail generation not implemented');
        return null;
      }

      return null;
    } catch (error) {
      logger.error('Thumbnail generation error:', error);
      return null;
    }
  }

  /**
   * Compress image
   */
  async compressImage(filePath, options = {}) {
    try {
      const quality = options.quality || 80;
      const ext = path.extname(filePath).toLowerCase();

      // Only compress certain image types
      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        return null;
      }

      const compressedPath = filePath.replace(ext, `_compressed${ext}`);

      await sharp(filePath).jpeg({ quality }).toFile(compressedPath);

      const stats = fs.statSync(compressedPath);

      // Replace original if compressed is smaller
      if (stats.size < fs.statSync(filePath).size) {
        fs.unlinkSync(filePath);
        fs.renameSync(compressedPath, filePath);

        return {
          path: filePath,
          url: this.getFileUrl({ path: filePath }),
          size: stats.size,
          quality,
        };
      } else {
        // Keep original if compression didn't reduce size
        fs.unlinkSync(compressedPath);
        return null;
      }
    } catch (error) {
      logger.error('Image compression error:', error);
      return null;
    }
  }

  /**
   * Get image dimensions
   */
  async getImageDimensions(filePath) {
    try {
      const metadata = await sharp(filePath).metadata();
      return {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
      };
    } catch (error) {
      logger.error('Get image dimensions error:', error);
      return null;
    }
  }

  /**
   * Get media duration (placeholder - would need ffmpeg for actual implementation)
   */
  async getMediaDuration(filePath) {
    // This is a placeholder implementation
    // In production, you would use ffmpeg or similar library
    logger.warn('Media duration detection not implemented');
    return null;
  }

  /**
   * Delete file
   */
  async deleteFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info('File deleted:', { path: filePath });
        return true;
      }
      return false;
    } catch (error) {
      logger.error('File deletion error:', error);
      throw error;
    }
  }

  /**
   * Delete multiple files
   */
  async deleteFiles(filePaths) {
    const results = [];

    for (const filePath of filePaths) {
      try {
        const deleted = await this.deleteFile(filePath);
        results.push({ path: filePath, deleted });
      } catch (error) {
        results.push({ path: filePath, error: error.message });
      }
    }

    return results;
  }

  /**
   * Get file type from MIME type
   */
  getFileType(mimeType) {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  /**
   * Get file URL for access
   */
  getFileUrl(file) {
    const relativePath = file.path.replace(/\\/g, '/').replace(this.uploadPath, '');
    return `/uploads${relativePath}`;
  }

  /**
   * Get file statistics
   */
  getFileStats(filePath) {
    try {
      const stats = fs.statSync(filePath);
      return {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime,
        accessed: stats.atime,
      };
    } catch (error) {
      logger.error('Get file stats error:', error);
      return null;
    }
  }

  /**
   * Scan directory for files
   */
  scanDirectory(dirPath, options = {}) {
    try {
      const files = [];
      const scan = currentPath => {
        const items = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const item of items) {
          const fullPath = path.join(currentPath, item.name);

          if (item.isDirectory() && options.recursive) {
            scan(fullPath);
          } else if (item.isFile()) {
            const stats = this.getFileStats(fullPath);

            if (
              stats &&
              (!options.minSize || stats.size >= options.minSize) &&
              (!options.maxSize || stats.size <= options.maxSize) &&
              (!options.extensions ||
                options.extensions.includes(path.extname(item.name).toLowerCase()))
            ) {
              files.push({
                name: item.name,
                path: fullPath,
                relativePath: path.relative(dirPath, fullPath),
                ...stats,
              });
            }
          }
        }
      };

      scan(dirPath);
      return files;
    } catch (error) {
      logger.error('Scan directory error:', error);
      return [];
    }
  }

  /**
   * Clean up old files
   */
  async cleanupOldFiles(dirPath, maxAgeDays = 30) {
    try {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const files = this.scanDirectory(dirPath, { recursive: true });
      const deleted = [];

      for (const file of files) {
        if (file.modified.getTime() < cutoff) {
          await this.deleteFile(file.path);
          deleted.push(file);
        }
      }

      logger.info(`Cleaned up ${deleted.length} old files from ${dirPath}`);
      return deleted;
    } catch (error) {
      logger.error('Cleanup old files error:', error);
      return [];
    }
  }
}

// Create singleton instance
const fileUpload = new FileUpload();

module.exports = {
  uploadFile: fileUpload.uploadFile.bind(fileUpload),
  uploadFiles: fileUpload.uploadFiles.bind(fileUpload),
  deleteFile: fileUpload.deleteFile.bind(fileUpload),
  deleteFiles: fileUpload.deleteFiles.bind(fileUpload),
  generateThumbnail: fileUpload.generateThumbnail.bind(fileUpload),
  compressImage: fileUpload.compressImage.bind(fileUpload),
  getImageDimensions: fileUpload.getImageDimensions.bind(fileUpload),
  getMulter: fileUpload.getMulter.bind(fileUpload),
  getFileUrl: fileUpload.getFileUrl.bind(fileUpload),
  getFileType: fileUpload.getFileType.bind(fileUpload),
  cleanupOldFiles: fileUpload.cleanupOldFiles.bind(fileUpload),
  scanDirectory: fileUpload.scanDirectory.bind(fileUpload),
};
