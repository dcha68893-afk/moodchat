'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    console.log('Checking for and fixing duplicate index issues...');
    
    // Helper function to safely add index
    const safeAddIndex = async (tableName, columns, options = {}) => {
      try {
        // Get existing indexes
        const indexes = await queryInterface.showIndex(tableName);
        
        // Check if similar index already exists
        const indexExists = indexes.some(index => {
          // Check if columns match
          const columnsMatch = JSON.stringify(index.columns) === JSON.stringify(columns);
          
          // Check if index name matches (if provided)
          if (options.name) {
            return index.name === options.name;
          }
          
          return columnsMatch;
        });
        
        if (!indexExists) {
          await queryInterface.addIndex(tableName, columns, options);
          console.log(`Created index ${options.name || 'unnamed'} on ${tableName}`);
        } else {
          console.log(`Index already exists on ${tableName} for columns: ${columns.join(', ')}`);
        }
      } catch (error) {
        if (error.message.includes('already exists')) {
          console.log(`Index already exists for ${tableName}: ${options.name || 'unnamed'}`);
        } else {
          console.log(`Error creating index for ${tableName}:`, error.message);
        }
      }
    };
    
    // Check for Profiles table and handle its unique index
    const profilesExists = await queryInterface.tableExists('Profiles');
    if (profilesExists) {
      await safeAddIndex('Profiles', ['userId'], {
        unique: true,
        name: 'profiles_user_id_unique_idx'
      });
    }
    
    // Check for other common tables that might have duplicate index issues
    const tablesToCheck = [
      'Users',
      'Messages', 
      'Groups',
      'Friends',
      'Tokens',
      'Calls',
      'Chats',
      'GroupMembers',
      'Status',
      'Profile',
      'ReadReceipt',
      'TypingIndicator',
      'Mood',
      'SharedMood',
      'Media',
      'Notifications',
      'UserStatus'
    ];
    
    for (const tableName of tablesToCheck) {
      const tableExists = await queryInterface.tableExists(tableName);
      if (tableExists) {
        console.log(`Checking indexes for ${tableName}...`);
        
        // Get all foreign key columns that might need indexes
        const tableInfo = await queryInterface.describeTable(tableName);
        const foreignKeyColumns = Object.keys(tableInfo).filter(col => 
          col.toLowerCase().includes('userid') || 
          col.toLowerCase().includes('id') ||
          col === 'userId' || 
          col === 'groupId' ||
          col === 'messageId' ||
          col === 'friendId' ||
          col === 'chatId' ||
          col === 'callId' ||
          col === 'moodId' ||
          col === 'mediaId' ||
          col === 'notificationId' ||
          col === 'statusId'
        );
        
        // Add indexes for foreign key columns
        for (const column of foreignKeyColumns) {
          await safeAddIndex(tableName, [column], {
            name: `${tableName.toLowerCase()}_${column.toLowerCase()}_idx`
          });
        }
        
        // Add composite indexes for common query patterns
        if (tableName === 'Messages') {
          await safeAddIndex('Messages', ['room', 'createdAt'], {
            name: 'messages_room_created_at_idx'
          });
        }
        
        if (tableName === 'Friends') {
          await safeAddIndex('Friends', ['userId', 'friendId'], {
            unique: true,
            name: 'friends_user_friend_unique_idx'
          });
        }
      }
    }
    
    console.log('Duplicate index check complete.');
  },

  async down(queryInterface, Sequelize) {
    console.log('No action needed for down migration - indexes remain');
  }
};