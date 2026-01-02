const { Op } = require('sequelize');
const { DataTypes } = require('sequelize');
const sequelize = require('./index');

const Mood = sequelize.define(
  'Mood',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    mood: {
      type: DataTypes.ENUM(
        'happy',
        'sad',
        'angry',
        'excited',
        'calm',
        'anxious',
        'tired',
        'energetic',
        'neutral'
      ),
      allowNull: false,
    },
    intensity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 5,
      validate: {
        min: 1,
        max: 10,
      },
    },
    note: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    triggers: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
    },
    location: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    weather: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    isPublic: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      defaultValue: [],
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING(7),
      allowNull: true,
      validate: {
        is: /^#[0-9A-F]{6}$/i,
      },
    },
    icon: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
      allowNull: false,
    },
  },
  {
    tableName: 'moods',
    timestamps: true,
    underscored: true,
    indexes: [
      {
        fields: ['user_id'],
      },
      {
        fields: ['mood'],
      },
      {
        fields: ['created_at'],
      },
      {
        fields: ['is_public'],
      },
      {
        fields: ['expires_at'],
      },
    ],
    hooks: {
      beforeCreate: async mood => {
        // Set default color based on mood
        if (!mood.color) {
          const moodColors = {
            happy: '#FFD700',
            sad: '#1E90FF',
            angry: '#FF4500',
            excited: '#FF69B4',
            calm: '#32CD32',
            anxious: '#8A2BE2',
            tired: '#A9A9A9',
            energetic: '#00FF00',
            neutral: '#808080',
          };
          mood.color = moodColors[mood.mood] || '#808080';
        }

        // Set default icon
        if (!mood.icon) {
          const moodIcons = {
            happy: '😊',
            sad: '😢',
            angry: '😠',
            excited: '🤩',
            calm: '😌',
            anxious: '😰',
            tired: '😴',
            energetic: '💪',
            neutral: '😐',
          };
          mood.icon = moodIcons[mood.mood] || '😐';
        }

        // Set expiration (moods expire after 24 hours by default)
        if (!mood.expiresAt) {
          mood.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
      },
    },
  }
);

// Instance methods
Mood.prototype.shareWithFriend = async function (friendId) {
  // Create a shared mood entry
  const SharedMood = sequelize.models.SharedMood;

  return await SharedMood.create({
    moodId: this.id,
    userId: this.userId,
    sharedWithId: friendId,
    sharedAt: new Date(),
  });
};

Mood.prototype.getMoodTrend = async function (days = 7) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const moods = await Mood.findAll({
    where: {
      userId: this.userId,
      createdAt: { [Op.gte]: startDate },
    },
    attributes: [
      'mood',
      'intensity',
      'createdAt',
      [sequelize.fn('DATE', sequelize.col('created_at')), 'date'],
    ],
    order: [['createdAt', 'ASC']],
  });

  return moods;
};

// Static methods
Mood.getUserMoods = async function (userId, options = {}) {
  const where = {
    userId: userId,
  };

  if (options.startDate) {
    where.createdAt = { [Op.gte]: options.startDate };
  }

  if (options.endDate) {
    where.createdAt = { [Op.lte]: options.endDate };
  }

  if (options.mood) {
    where.mood = options.mood;
  }

  return await this.findAll({
    where: where,
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Mood.getPublicMoods = async function (options = {}) {
  const where = {
    isPublic: true,
  };

  if (options.userId) {
    where.userId = options.userId;
  }

  if (options.mood) {
    where.mood = options.mood;
  }

  return await this.findAll({
    where: where,
    include: [
      {
        model: sequelize.models.User,
        attributes: ['id', 'username', 'avatar'],
      },
    ],
    order: [['createdAt', 'DESC']],
    limit: options.limit || 50,
    offset: options.offset || 0,
  });
};

Mood.getMoodStats = async function (userId, days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await this.findAll({
    where: {
      userId: userId,
      createdAt: { [Op.gte]: startDate },
    },
    attributes: [
      'mood',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [sequelize.fn('AVG', sequelize.col('intensity')), 'averageIntensity'],
    ],
    group: ['mood'],
    order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
  });

  return stats;
};

Mood.cleanupExpired = async function () {
  return await this.destroy({
    where: {
      expiresAt: { [Op.lt]: new Date() },
    },
  });
};

module.exports = Mood;
