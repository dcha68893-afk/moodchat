'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Check if Tokens table exists and has the problematic index
    const tableExists = await queryInterface.tableExists('Tokens');
    
    if (tableExists) {
      // Get all indexes on the Tokens table
      const indexes = await queryInterface.showIndex('Tokens');
      
      // Check if the tokens_token index exists (the problematic one)
      const tokenIndexExists = indexes.some(index => 
        index.name === 'tokens_token' || 
        index.name === 'Tokens_token' ||
        index.name.includes('token')
      );
      
      // If the problematic index doesn't exist, create it with a different name
      if (!tokenIndexExists) {
        try {
          await queryInterface.addIndex('Tokens', ['token'], {
            name: 'tokens_token_value_idx'
          });
          console.log('Created new token index: tokens_token_value_idx');
        } catch (error) {
          console.log('Could not create token index:', error.message);
        }
      } else {
        console.log('Token index already exists, skipping creation');
      }
      
      // Similarly for other indexes
      const userIdIndexExists = indexes.some(index => 
        index.name === 'tokens_user_id' || 
        index.name === 'Tokens_userId' ||
        index.name.includes('userId') ||
        index.name.includes('user_id')
      );
      
      if (!userIdIndexExists) {
        try {
          await queryInterface.addIndex('Tokens', ['userId'], {
            name: 'tokens_user_id_idx'
          });
          console.log('Created new user_id index: tokens_user_id_idx');
        } catch (error) {
          console.log('Could not create user_id index:', error.message);
        }
      }
      
      const expiresAtIndexExists = indexes.some(index => 
        index.name === 'tokens_expires_at' || 
        index.name === 'Tokens_expiresAt' ||
        index.name.includes('expiresAt') ||
        index.name.includes('expires_at')
      );
      
      if (!expiresAtIndexExists) {
        try {
          await queryInterface.addIndex('Tokens', ['expiresAt'], {
            name: 'tokens_expires_at_idx'
          });
          console.log('Created new expires_at index: tokens_expires_at_idx');
        } catch (error) {
          console.log('Could not create expires_at index:', error.message);
        }
      }
    }
  },

  async down(queryInterface, Sequelize) {
    // Safely remove indexes if they exist
    try {
      await queryInterface.removeIndex('Tokens', 'tokens_token_value_idx');
    } catch (error) {
      // Index doesn't exist, that's fine
    }
    
    try {
      await queryInterface.removeIndex('Tokens', 'tokens_user_id_idx');
    } catch (error) {
      // Index doesn't exist, that's fine
    }
    
    try {
      await queryInterface.removeIndex('Tokens', 'tokens_expires_at_idx');
    } catch (error) {
      // Index doesn't exist, that's fine
    }
  }
};