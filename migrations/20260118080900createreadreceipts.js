// 20260120000200-createreadreceipts.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
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
            model: 'messages',  // Foreign key to Messages table
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
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