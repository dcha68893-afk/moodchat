// --- MODEL: File.js ---
module.exports = (sequelize, DataTypes) => {
  const File = sequelize.define(
    'File',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false
      },
      filename: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          notEmpty: true
        }
      },
      originalName: {
        type: DataTypes.STRING,
        allowNull: false
      },
      fileType: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          isIn: [['image', 'document', 'audio', 'video', 'archive', 'other']]
        }
      },
      mimeType: {
        type: DataTypes.STRING,
        allowNull: false
      },
      size: {
        type: DataTypes.BIGINT,
        allowNull: false,
        validate: {
          min: 0
        }
      },
      path: {
        type: DataTypes.STRING,
        allowNull: false
      },
      thumbnailPath: {
        type: DataTypes.STRING,
        allowNull: true
      },
      isPublic: {
        type: DataTypes.BOOLEAN,
        defaultValue: false
      },
      uploadStatus: {
        type: DataTypes.STRING,
        defaultValue: 'completed',
        validate: {
          isIn: [['pending', 'uploading', 'completed', 'failed']]
        }
      },
      downloadCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        validate: {
          min: 0
        }
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
        validate: {
          len: [0, 500]
        }
      },
      uploadedBy: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      noteId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {}
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: true
      }
    },
    {
      tableName: 'files',
      modelName: 'File',
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['uploaded_by']
        },
        {
          fields: ['note_id']
        },
        {
          fields: ['file_type']
        },
        {
          fields: ['is_public']
        },
        {
          fields: ['upload_status']
        },
        {
          fields: ['expires_at']
        }
      ]
    }
  );

  // Virtual property (PRESERVED)
  File.prototype.getReadableSize = function() {
    const bytes = this.size;
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Static methods (PRESERVED)
  File.getUserFiles = async function(userId) {
    return await this.findAll({
      where: { uploadedBy: userId },
      order: [['created_at', 'DESC']]
    });
  };

  File.getPublicFiles = async function() {
    return await this.findAll({
      where: { 
        isPublic: true,
        uploadStatus: 'completed'
      },
      order: [['created_at', 'DESC']]
    });
  };

  File.incrementDownloadCount = async function(fileId) {
    const file = await this.findByPk(fileId);
    if (!file) {
      throw new Error('File not found');
    }
    
    file.downloadCount += 1;
    return await file.save();
  };

  // Instance methods (PRESERVED)
  File.prototype.markAsFailed = function() {
    this.uploadStatus = 'failed';
    return this.save();
  };

  File.prototype.isExpired = function() {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  };

  File.prototype.canDownload = function(userId) {
    if (this.isPublic) return true;
    if (this.uploadedBy === userId) return true;
    return false;
  };

  // FIXED: Associations with unique aliases
  File.associate = (models) => {
    if (models.Users) {
      File.belongsTo(models.Users, {
        foreignKey: 'uploadedBy',
        as: 'fileUploader',
        constraints: true,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Notes) {
      File.belongsTo(models.Notes, {
        foreignKey: 'noteId',
        as: 'fileNote',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  return File;
};
