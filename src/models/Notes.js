module.exports = (sequelize, DataTypes) => {
  const Notes = sequelize.define('Notes', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      allowNull: false
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: true
      }
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    isArchived: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    isPinned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: []
    },
    category: {
      type: DataTypes.STRING,
      defaultValue: 'general',
      validate: {
        isIn: [['general', 'work', 'personal', 'ideas', 'archive']]
      }
    },
    colorCode: {
      type: DataTypes.STRING,
      defaultValue: '#ffffff',
      validate: {
        isHexColor: true
      }
    },
    wordCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      validate: {
        min: 0
      }
    },
    lastEditedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'Users',
        key: 'id'
      }
    },
    version: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {}
    }
  }, {
    tableName: 'notes',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['created_by']
      },
      {
        fields: ['is_archived']
      },
      {
        fields: ['is_pinned']
      },
      {
        fields: ['category']
      }
    ]
  });

  // Virtual property
  Notes.prototype.getSummary = function() {
    if (!this.content) return '';
    return this.content.substring(0, 100) + (this.content.length > 100 ? '...' : '');
  };

  // Static methods
  Notes.getUserNotes = async function(userId) {
    return await this.findAll({
      where: { createdBy: userId },
      order: [['updated_at', 'DESC']]
    });
  };

  Notes.getPinnedNotes = async function(userId) {
    return await this.findAll({
      where: { 
        createdBy: userId,
        isPinned: true,
        isArchived: false
      },
      order: [['updated_at', 'DESC']]
    });
  };

  Notes.archiveNote = async function(noteId, userId) {
    const note = await this.findOne({ 
      where: { 
        id: noteId,
        createdBy: userId 
      } 
    });
    
    if (!note) {
      throw new Error('Note not found or unauthorized');
    }
    
    note.isArchived = true;
    note.lastEditedAt = new Date();
    return await note.save();
  };

  // Instance methods
  Notes.prototype.incrementWordCount = function() {
    if (this.content) {
      this.wordCount = this.content.split(/\s+/).length;
    }
    return this.wordCount;
  };

  Notes.prototype.addTag = function(tag) {
    if (!this.tags.includes(tag)) {
      this.tags = [...this.tags, tag];
    }
    return this.tags;
  };

  Notes.associate = (models) => {
    Notes.belongsTo(models.Users, {
      foreignKey: 'createdBy',
      as: 'noteAuthor',
      constraints: false,
    });
    
    Notes.hasMany(models.File, {
      foreignKey: 'noteId',
      as: 'noteAttachments',
      constraints: false,
    });
  };

  return Notes;
};