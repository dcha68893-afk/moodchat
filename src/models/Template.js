// --- MODEL: Template.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Template = sequelize.define(
    'Template',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
      },
      name: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(200),
        allowNull: false,
        unique: true,
      },
      categoryId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('system', 'user', 'community'),
        defaultValue: 'user',
        allowNull: false,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      variables: {
        type: DataTypes.JSONB,
        defaultValue: [],
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      thumbnail: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      previewUrl: {
        type: DataTypes.STRING,
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
      isFeatured: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      usageCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      favoritesCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      rating: {
        type: DataTypes.FLOAT,
        defaultValue: 0,
        allowNull: false,
        validate: {
          min: 0,
          max: 5,
        },
      },
      ratingCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      createdBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      updatedBy: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
        allowNull: false,
      },
      version: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('draft', 'published', 'archived', 'rejected'),
        defaultValue: 'draft',
        allowNull: false,
      },
      publishedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      archivedAt: {
        type: DataTypes.DATE,
        allowNull: true,
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
      tableName: 'Templates',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [],
    }
  );

  // Instance methods
  Template.prototype.publish = async function () {
    this.status = 'published';
    this.publishedAt = new Date();
    return await this.save();
  };

  Template.prototype.archive = async function () {
    this.status = 'archived';
    this.archivedAt = new Date();
    return await this.save();
  };

  Template.prototype.incrementUsage = async function () {
    this.usageCount += 1;
    return await this.save();
  };

  Template.prototype.addFavorite = async function () {
    this.favoritesCount += 1;
    return await this.save();
  };

  Template.prototype.removeFavorite = async function () {
    this.favoritesCount = Math.max(0, this.favoritesCount - 1);
    return await this.save();
  };

  Template.prototype.updateRating = async function (newRating) {
    const totalRating = this.rating * this.ratingCount + newRating;
    this.ratingCount += 1;
    this.rating = totalRating / this.ratingCount;
    return await this.save();
  };

  Template.prototype.render = async function (variables = {}) {
    let renderedContent = this.content;
    
    this.variables.forEach(variable => {
      const placeholder = `{{${variable.name}}}`;
      const value = variables[variable.name] || variable.default || '';
      renderedContent = renderedContent.replace(new RegExp(placeholder, 'g'), value);
    });
    
    return renderedContent;
  };

  // Static methods
  Template.getPublishedTemplates = async function (categoryId = null, options = {}) {
    const where = {
      status: 'published',
      isPublic: true,
    };

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (options.search) {
      where[Op.or] = [
        { name: { [Op.iLike]: `%${options.search}%` } },
        { description: { [Op.iLike]: `%${options.search}%` } },
        { tags: { [Op.contains]: [options.search] } },
      ];
    }

    const include = [];
    
    if (this.sequelize.models.Category) {
      include.push({
        model: this.sequelize.models.Category,
        as: 'templateCategory',
        attributes: ['id', 'name', 'slug'],
      });
    }
    
    if (this.sequelize.models.Users) {
      include.push({
        model: this.sequelize.models.Users,
        as: 'templateCreator',
        foreignKey: 'createdBy',
        attributes: ['id', 'username', 'avatar'],
      });
    }

    return await this.findAll({
      where: where,
      include: include.length > 0 ? include : undefined,
      order: options.order || [['usageCount', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  Template.getUserTemplates = async function (userId, options = {}) {
    const where = {
      createdBy: userId,
    };

    if (options.status) {
      where.status = options.status;
    }

    if (options.type) {
      where.type = options.type;
    }

    const include = [];
    
    if (this.sequelize.models.Category) {
      include.push({
        model: this.sequelize.models.Category,
        as: 'templateCategory',
        attributes: ['id', 'name', 'slug'],
      });
    }

    return await this.findAll({
      where: where,
      include: include.length > 0 ? include : undefined,
      order: [['updatedAt', 'DESC']],
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  };

  Template.getFeaturedTemplates = async function (limit = 10) {
    return await this.findAll({
      where: {
        isFeatured: true,
        status: 'published',
        isPublic: true,
      },
      include: this.sequelize.models.Category ? [{
        model: this.sequelize.models.Category,
        as: 'templateCategory',
        attributes: ['id', 'name', 'slug'],
      }] : undefined,
      order: [['favoritesCount', 'DESC']],
      limit: limit,
    });
  };

  Template.findBySlug = async function (slug) {
    return await this.findOne({
      where: { slug },
      include: [
        this.sequelize.models.Category ? {
          model: this.sequelize.models.Category,
          as: 'templateCategory',
          attributes: ['id', 'name', 'slug'],
        } : undefined,
        this.sequelize.models.Users ? {
          model: this.sequelize.models.Users,
          as: 'templateCreator',
          foreignKey: 'createdBy',
          attributes: ['id', 'username', 'avatar'],
        } : undefined,
      ].filter(Boolean),
    });
  };

  Template.associate = function (models) {
    if (models.Category) {
      Template.belongsTo(models.Category, {
        foreignKey: 'categoryId',
        as: 'templateCategory',
        constraints: false,
      });
    }
    
    if (models.Users) {
      Template.belongsTo(models.Users, {
        as: 'templateCreator',
        foreignKey: 'createdBy',
        constraints: false,
      });
      
      Template.belongsTo(models.Users, {
        as: 'templateUpdater',
        foreignKey: 'updatedBy',
        constraints: false,
      });
    }
  };

  return Template;
};