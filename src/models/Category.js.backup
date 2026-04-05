// --- MODEL: Category.js ---
const { Op } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  const Category = sequelize.define(
    'Category',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        allowNull: false,
        defaultValue: DataTypes.UUIDV4,
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      slug: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: true,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      parentId: {
        type: DataTypes.UUID,
        allowNull: true,
      },
      icon: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      color: {
        type: DataTypes.STRING(7),
        allowNull: true,
        validate: {
          is: /^#[0-9A-F]{6}$/i,
        },
      },
      order: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      templateCount: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        allowNull: false,
      },
      isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        allowNull: false,
      },
      isFeatured: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        allowNull: false,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
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
      tableName: 'Categories',
      modelName: 'Category',
      timestamps: true,
      underscored: false,
      freezeTableName: true,
      indexes: [
        {
          fields: ['slug'],
          unique: true,
        },
        {
          fields: ['parentId'],
        },
        {
          fields: ['isActive'],
        },
        {
          fields: ['isFeatured'],
        },
      ],
    }
  );

  // Instance methods (PRESERVED)
  Category.prototype.incrementTemplateCount = async function () {
    this.templateCount += 1;
    return await this.save();
  };

  Category.prototype.decrementTemplateCount = async function () {
    this.templateCount = Math.max(0, this.templateCount - 1);
    return await this.save();
  };

  Category.prototype.getSubcategories = async function () {
    return await this.constructor.findAll({
      where: {
        parentId: this.id,
        isActive: true,
      },
      order: [['order', 'ASC'], ['name', 'ASC']],
    });
  };

  Category.prototype.getTemplates = async function (options = {}) {
    const Template = this.sequelize.models.Template;
    if (!Template) {
      throw new Error('Template model is not available');
    }

    const where = {
      categoryId: this.id,
      status: 'published',
      isPublic: true,
    };

    if (options.type) {
      where.type = options.type;
    }

    return await Template.findAll({
      where: where,
      order: options.order || [['usageCount', 'DESC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  // Static methods (PRESERVED)
  Category.getRootCategories = async function () {
    return await this.findAll({
      where: {
        parentId: null,
        isActive: true,
      },
      order: [['order', 'ASC'], ['name', 'ASC']],
    });
  };

  Category.getCategoryTree = async function () {
    const rootCategories = await this.getRootCategories();
    
    const buildTree = async (category) => {
      const subcategories = await category.getSubcategories();
      const categoryJson = category.toJSON();
      
      if (subcategories.length > 0) {
        categoryJson.subcategories = await Promise.all(
          subcategories.map(buildTree)
        );
      } else {
        categoryJson.subcategories = [];
      }
      
      return categoryJson;
    };

    return await Promise.all(rootCategories.map(buildTree));
  };

  Category.findBySlug = async function (slug, includeChildren = false) {
    const category = await this.findOne({
      where: { slug, isActive: true },
    });

    if (!category || !includeChildren) {
      return category;
    }

    const categoryJson = category.toJSON();
    categoryJson.subcategories = await category.getSubcategories();
    return categoryJson;
  };

  Category.getFeaturedCategories = async function (limit = 10) {
    return await this.findAll({
      where: {
        isFeatured: true,
        isActive: true,
      },
      order: [['templateCount', 'DESC']],
      limit: limit,
    });
  };

  Category.searchCategories = async function (searchTerm, options = {}) {
    const where = {
      isActive: true,
      [Op.or]: [
        { name: { [Op.iLike]: `%${searchTerm}%` } },
        { description: { [Op.iLike]: `%${searchTerm}%` } },
      ],
    };

    if (options.parentId) {
      where.parentId = options.parentId;
    }

    return await this.findAll({
      where: where,
      order: [['order', 'ASC'], ['name', 'ASC']],
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  };

  // FIXED: Associations with unique aliases
  Category.associate = function (models) {
    // Self-referential relationship for parent-child categories
    Category.belongsTo(models.Category, {
      as: 'parentCategory',
      foreignKey: 'parentId',
      constraints: false,
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });

    Category.hasMany(models.Category, {
      as: 'childCategories',
      foreignKey: 'parentId',
      constraints: false,
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });

    if (models.Template) {
      Category.hasMany(models.Template, {
        foreignKey: 'categoryId',
        as: 'categoryTemplates',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
    
    if (models.Users) {
      Category.belongsTo(models.Users, {
        as: 'categoryCreator',
        foreignKey: 'createdBy',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
      
      Category.belongsTo(models.Users, {
        as: 'categoryUpdater',
        foreignKey: 'updatedBy',
        constraints: false,
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  };

  return Category;
};