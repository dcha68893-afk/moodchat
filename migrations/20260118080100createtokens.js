'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table already exists
    const tableExists = await queryInterface.tableExists('Tokens');
    
    if (!tableExists) {
      await queryInterface.createTable('Tokens', {
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
            model: 'users',
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        token: {
          type: Sequelize.TEXT,
          allowNull: false
        },
        type: {
          type: Sequelize.STRING,
          allowNull: false,
          defaultValue: 'refresh'
        },
        isRevoked: {
          type: Sequelize.BOOLEAN,
          defaultValue: false,
          allowNull: false
        },
        expiresAt: {
          type: Sequelize.DATE,
          allowNull: false
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

      // Add indexes with explicit names
      await queryInterface.addIndex('Tokens', ['token'], {
        name: 'tokens_token_idx'
      });
      
      await queryInterface.addIndex('Tokens', ['userId'], {
        name: 'tokens_user_id_idx'
      });
      
      await queryInterface.addIndex('Tokens', ['expiresAt'], {
        name: 'tokens_expires_at_idx'
      });
    } else {
      console.log('Tokens table already exists, skipping creation.');
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Tokens');
  }
};