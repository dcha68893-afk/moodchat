'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE chat_participants cp
       SET "role" = 'admin', "updatedAt" = NOW()
       FROM chats c
       WHERE cp."chatId" = c.id
         AND c.type = 'group'
         AND c."createdBy" = cp."userId"`
    );

    await queryInterface.sequelize.query(
      `UPDATE chats
       SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{allowMemberInvites}',
         COALESCE(settings->'allowMemberInvites', 'true'::jsonb),
         true
       ),
       "updatedAt" = NOW()
       WHERE type = 'group'`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE chat_participants cp
       SET "role" = 'member', "updatedAt" = NOW()
       FROM chats c
       WHERE cp."chatId" = c.id
         AND c.type = 'group'
         AND c."createdBy" = cp."userId"`
    );
  }
};
