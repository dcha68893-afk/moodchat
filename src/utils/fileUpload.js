const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const logger = require('./logger');

class FileUpload {
  constructor() {
    this.uploadPath = path.join(__dirname, '../../uploads');
    this.maxFileSize = 5 * 1024 * 1024;
    this.allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    this.ensureUploadDirectory();
  }

  ensureUploadDirectory() {
    if (!fs.existsSync(this.uploadPath)) {
      fs.mkdirSync(this.uploadPath, { recursive: true });
      fs.mkdirSync(path.join(this.uploadPath, 'profiles'), { recursive: true });
    }
  }

  getStorage() {
    return multer.diskStorage({
      destination: (req, file, cb) => {
        const profileDir = path.join(this.uploadPath, 'profiles');
        if (!fs.existsSync(profileDir)) {
          fs.mkdirSync(profileDir, { recursive: true });
        }
        cb(null, profileDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        // FIX-XSS-EXT-SMUGGLING: never trust the client-supplied filename's
        // extension — same issue and same fix as src/config/upload.js. A
        // client could claim an allowed image mimetype while naming the file
        // 'x.html', and express.static would later serve it back as
        // Content-Type: text/html based on that extension.
        const SAFE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
        const ext = SAFE_EXT[file.mimetype] || 'jpg';
        const filename = `profile-${uniqueSuffix}.${ext}`;
        cb(null, filename);
      }
    });
  }

  fileFilter(req, file, cb) {
    if (this.allowedImageTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed types: JPEG, PNG, GIF, WEBP'), false);
    }
  }

  getMulter() {
    return multer({
      storage: this.getStorage(),
      fileFilter: this.fileFilter.bind(this),
      limits: {
        fileSize: this.maxFileSize
      }
    });
  }

  async processImage(filePath, options = {}) {
    try {
      const image = sharp(filePath);
      
      if (options.resize) {
        const { width, height, fit = 'cover' } = options.resize;
        image.resize(width, height, { fit });
      }

      if (options.format) {
        image.toFormat(options.format, {
          quality: options.quality || 80,
        });
      }

      const outputPath = filePath.replace(
        path.extname(filePath),
        `_processed${path.extname(filePath)}`
      );

      await image.toFile(outputPath);
      fs.unlinkSync(filePath);
      fs.renameSync(outputPath, filePath);

      logger.info('Image processed successfully');
      return true;
    } catch (error) {
      logger.error('Image processing error:', error);
      throw error;
    }
  }

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

  async generateThumbnail(filePath, options = {}) {
    try {
      const ext = path.extname(filePath);
      const thumbnailPath = filePath.replace(ext, '_thumb.jpg');

      await sharp(filePath)
        .resize(options.thumbnailWidth || 200, options.thumbnailHeight || 200, {
          fit: 'cover',
          position: 'center',
        })
        .jpeg({ quality: options.thumbnailQuality || 70 })
        .toFile(thumbnailPath);

      return {
        path: thumbnailPath,
        url: `/uploads/profiles/${path.basename(thumbnailPath)}`,
      };
    } catch (error) {
      logger.error('Thumbnail generation error:', error);
      return null;
    }
  }

  async compressImage(filePath, options = {}) {
    try {
      const quality = options.quality || 80;
      const ext = path.extname(filePath).toLowerCase();

      if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        return null;
      }

      const compressedPath = filePath.replace(ext, `_compressed${ext}`);

      await sharp(filePath).jpeg({ quality }).toFile(compressedPath);

      const stats = fs.statSync(compressedPath);

      if (stats.size < fs.statSync(filePath).size) {
        fs.unlinkSync(filePath);
        fs.renameSync(compressedPath, filePath);

        return {
          path: filePath,
          url: `/uploads/profiles/${path.basename(filePath)}`,
          size: stats.size,
          quality,
        };
      } else {
        fs.unlinkSync(compressedPath);
        return null;
      }
    } catch (error) {
      logger.error('Image compression error:', error);
      return null;
    }
  }

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
}

const fileUpload = new FileUpload();
const upload = fileUpload.getMulter();

module.exports = upload;