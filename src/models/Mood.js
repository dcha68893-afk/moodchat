// --- MODEL: Mood.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
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
          'focused',
          'relaxed',
          'nostalgic',
          'romantic',
          'lonely',
          'confused',
          'proud',
          'grateful',
          'hopeful',
          'bored',
          'sick',
          'neutral'
        ),
        allowNull: false,
      },
      intensity: {
        type: DataTypes.INTEGER,
        defaultValue: 5,
        validate: {
          min: 1,
          max: 10,
        },
        allowNull: false,
      },
      notes: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      isPublic: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      sharedWith: {
        type: DataTypes.ARRAY(DataTypes.INTEGER),
        defaultValue: [],
        allowNull: false,
      },
      location: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      weather: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      activities: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: [],
        allowNull: false,
      },
      mediaUrl: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'moods',                   // Standardized: lowercase table name
      modelName: 'Mood',                     // Explicit model name
      timestamps: true,
      underscored: true,
      freezeTableName: true,
      indexes: [
        {
          fields: ['userId'],
        },
        {
          fields: ['mood'],
        },
        {
          fields: ['createdAt'],
        },
        {
          fields: ['userId', 'createdAt'],
        },
        {
          fields: ['tags'],
          using: 'gin',
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
  Mood.prototype.shareWithUser = async function (userId) {
    if (!this.sharedWith.includes(userId)) {
      this.sharedWith = [...this.sharedWith, userId];
      await this.save();
    }
    return this;
  };

  Mood.prototype.unshareWithUser = async function (userId) {
    this.sharedWith = this.sharedWith.filter(id => id !== userId);
    await this.save();
    return this;
  };

  Mood.prototype.canView = function (userId) {
    return (
      this.userId === userId ||
      this.isPublic ||
      this.sharedWith.includes(userId)
    );
  };

  // Static methods (PRESERVED)
  Mood.getUserMoods = async function (userId, options = {}) {
    const where = { userId: userId };

    if (options.date) {
      where.createdAt = {
        [Op.between]: [
          new Date(options.date + 'T00:00:00.000Z'),
          new Date(options.date + 'T23:59:59.999Z'),
        ],
      };
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

  Mood.getMoodStats = async function (userId, days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const moods = await this.findAll({
      where: {
        userId: userId,
        createdAt: { [Op.gte]: startDate },
      },
      attributes: ['mood', 'intensity', 'createdAt'],
      order: [['createdAt', 'ASC']],
    });

    const stats = {
      total: moods.length,
      byMood: {},
      averageIntensity: 0,
      dailyAverage: {},
    };

    let totalIntensity = 0;

    moods.forEach(mood => {
      stats.byMood[mood.mood] = (stats.byMood[mood.mood] || 0) + 1;
      totalIntensity += mood.intensity;
      const date = mood.createdAt.toISOString().split('T')[0];
      if (!stats.dailyAverage[date]) {
        stats.dailyAverage[date] = {
          count: 0,
          totalIntensity: 0,
        };
      }
      stats.dailyAverage[date].count++;
      stats.dailyAverage[date].totalIntensity += mood.intensity;
    });

    stats.averageIntensity = moods.length > 0 ? totalIntensity / moods.length : 0;

    stats.dailyAverage = Object.entries(stats.dailyAverage).map(([date, data]) => ({
      date,
      averageIntensity: data.totalIntensity / data.count,
      count: data.count,
    }));

    return stats;
  };

  Mood.getSharedMoods = async function (userId) {
    return await this.findAll({
      where: {
        sharedWith: { [Op.contains]: [userId] },
      },
      include: [
        {
          model: this.sequelize.models.Users,
          as: 'moodOwnerUser',                 // FIXED: Unique alias
          attributes: ['id', 'username', 'avatar'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  };

  // FIXED: Associations with unique aliases
  Mood.associate = function(models) {
    if (models.Users) {
      Mood.belongsTo(models.Users, {
        foreignKey: 'userId',
        as: 'moodOwnerUser',                   // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.SharedMood) {
      Mood.hasMany(models.SharedMood, {
        foreignKey: 'moodId',
        as: 'moodSharesList',                   // FIXED: Unique alias
        constraints: false,
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Mood;
};