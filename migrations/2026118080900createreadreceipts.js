// 20260120000200-createreadreceipts.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const __tables = await queryInterface.showAllTables();
    const __exists = __tables.some(t => String(t).toLowerCase() === 'readreceipts');
    if (__exists) {
      console.log('[Migration] Skipping duplicate migration — ReadReceipts table already exists (created by the correctly-named 20260118... migration).');
      return;
    }
    // Check if table exists
    const tableExists = await queryInterface.tableExists('ReadReceipts');
    
    if (!tableExists) {
      await queryInterface.createTable('ReadReceipts', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true,
          allowNull: false
        },
        messageId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: {
            model: 'Messages',  // Foreign key to Messages table (FIX: was lowercase 'messages', actual table is 'Messages')
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
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
        readAt: {
          type: Sequelize.DATE,
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

      // Try to create index, catch if it already exists
      try {
        await queryInterface.addIndex('ReadReceipts', ['messageId', 'userId'], {
          unique: true,
          name: 'read_receipts_message_user_unique'
        });
        console.log('Created unique index on ReadReceipts');
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log('Unique index already exists, skipping');
        } else {
          throw error;
        }
      }
    } else {
      console.log('ReadReceipts table already exists, skipping creation.');
      
      // Check if index already exists
      try {
        const indexes = await queryInterface.showIndex('ReadReceipts');
        const compositeIndexExists = indexes.some(index => 
          index.unique && 
          index.columns && 
          index.columns.includes('messageId') && 
          index.columns.includes('userId')
        );
        
        if (!compositeIndexExists) {
          await queryInterface.addIndex('ReadReceipts', ['messageId', 'userId'], {
            unique: true,
            name: 'read_receipts_message_user_unique'
          });
          console.log('Created unique index on existing ReadReceipts table');
        } else {
          console.log('Unique composite index already exists on ReadReceipts');
        }
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log('Index already exists');
        } else {
          console.log('Error checking/creating index:', error.message);
        }
      }
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('ReadReceipts');
  }
};