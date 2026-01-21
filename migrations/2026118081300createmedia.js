// 20260120000600-createmedia.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Media', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Users',  // Foreign key to Users table
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false
      },
      chatId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'chatspages',  // Foreign key to Chats table
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    // Add indexes for common queries
    await queryInterface.addIndex('Media', ['userId'], {
      name: 'media_user_id_index'
    });
    await queryInterface.addIndex('Media', ['chatId'], {
      name: 'media_chat_id_index'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Media');
  }
};