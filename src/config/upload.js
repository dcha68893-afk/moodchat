const config = require('./index');

module.exports = {
  limits: {
    fileSize: config.upload.maxFileSize,
  },

  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      ...config.upload.allowedImageTypes,
      ...config.upload.allowedVideoTypes,
      ...config.upload.allowedAudioTypes,
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },

  storage: {
    destination: function (req, file, cb) {
      let uploadPath = config.upload.uploadPath;

      if (file.mimetype.startsWith('image/')) {
        uploadPath += 'images/';
      } else if (file.mimetype.startsWith('video/')) {
        uploadPath += 'videos/';
      } else if (file.mimetype.startsWith('audio/')) {
        uploadPath += 'audio/';
      } else {
        uploadPath += 'other/';
      }

      cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = file.originalname.split('.').pop();
      cb(null, file.fieldname + '-' + uniqueSuffix + '.' + ext);
    },
  },
};
