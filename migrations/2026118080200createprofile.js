// 20260120000100-createprofile.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if table exists
    const tableExists = await queryInterface.tableExists('Profiles');
    
    if (!tableExists) {
      await queryInterface.createTable('Profiles', {
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
            model: 'users',  // Foreign key to Users table
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        bio: {
          type: Sequelize.STRING,
          allowNull: true
        },
        avatarUrl: {
          type: Sequelize.STRING,
          allowNull: true
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

      // Check if unique index already exists before creating
      try {
        await queryInterface.addIndex('Profiles', ['userId'], {
          unique: true,
          name: 'profiles_user_id_unique'
        });
        console.log('Created unique index on Profiles.userId');
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log('Unique index on Profiles.userId already exists, skipping');
        } else {
          throw error;
        }
      }
    } else {
      console.log('Profiles table already exists, skipping creation.');
      
      // Still try to create the index if it doesn't exist
      try {
        const indexes = await queryInterface.showIndex('Profiles');
        const indexExists = indexes.some(index => 
          index.unique && index.columns.includes('userId')
        );
        
        if (!indexExists) {
          await queryInterface.addIndex('Profiles', ['userId'], {
            unique: true,
            name: 'profiles_user_id_unique'
          });
          console.log('Created unique index on existing Profiles table');
        } else {
          console.log('Unique index on Profiles.userId already exists');
        }
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log('Unique index already exists');
        } else {
          console.log('Error checking/creating index:', error.message);
        }
      }
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('Profiles');
  }
};