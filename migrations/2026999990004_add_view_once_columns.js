'use strict';

/**
 * NEW FEATURE: View Once media messages
 *
 * Adds two columns to Messages for tracking view-once state. A message with
 * type='view_once' carries its media in metadata.mediaUrl exactly like a
 * normal image/video message, but:
 *   - viewOnceViewedAt is NULL until the FIRST recipient opens it
 *   - viewOnceViewedBy records who opened it (for group chats, only the
 *     first viewer "uses up" the view; for 1:1 chats this is simply the
 *     other participant)
 * Once viewed, GET /api/messages/:chatId strips metadata.mediaUrl from the
 * response for everyone except the sender (who can still see it was sent),
 * and the underlying media file is deleted from storage — matching
 * WhatsApp/Signal's "view once" semantics where the media cannot be
 * re-opened, screenshotted-and-reopened via cache, or downloaded again.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Messages');

    if (!table.viewOnceViewedAt) {
      await queryInterface.addColumn('Messages', 'viewOnceViewedAt', {
        type: Sequelize.DATE,
        allowNull: true,
      });
    }
    if (!table.viewOnceViewedBy) {
      await queryInterface.addColumn('Messages', 'viewOnceViewedBy', {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Messages', 'viewOnceViewedBy').catch(() => {});
    await queryInterface.removeColumn('Messages', 'viewOnceViewedAt').catch(() => {});
  },
};
