'use strict';

/**
 * NEW FEATURE: Live Location Sharing
 *
 * Static (one-time) location pins already work via the existing message
 * send path: POST /api/messages with type='location' and
 * metadata.location={lat,lng} — no schema change needed for that.
 *
 * Live location is different: it's a TIME-BOUNDED, repeatedly-updated share
 * (e.g. "share my location for the next 15 minutes"), matching WhatsApp's
 * live location feature. This needs its own session table because:
 *   - a single share can update its coordinates many times over its duration
 *     without creating a new Messages row on every GPS tick
 *   - it needs an explicit start/stop lifecycle and auto-expiry
 *   - multiple participants in a group chat can each have their own
 *     concurrent live-location session
 *
 * The session is still anchored to a single Messages row (type='location',
 * metadata.isLive=true) so it appears once in the chat timeline; the session
 * table is the live, frequently-updated state behind that one message.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const exists = await queryInterface.tableExists('LiveLocationSessions');
    if (!exists) {
      await queryInterface.createTable('LiveLocationSessions', {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
        messageId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'Messages', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        chatId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'chats', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        userId: {
          type: Sequelize.INTEGER, allowNull: false,
          references: { model: 'users', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
        },
        latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: false },
        longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: false },
        accuracy: { type: Sequelize.FLOAT, allowNull: true, comment: 'GPS accuracy radius in meters' },
        heading: { type: Sequelize.FLOAT, allowNull: true, comment: 'Compass heading in degrees, if available' },
        speed: { type: Sequelize.FLOAT, allowNull: true, comment: 'Speed in meters/second, if available' },
        startedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        expiresAt: { type: Sequelize.DATE, allowNull: false },
        lastUpdatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        stoppedAt: { type: Sequelize.DATE, allowNull: true },
        stoppedReason: { type: Sequelize.STRING(20), allowNull: true, comment: "'manual', 'expired', or null while active" },
        createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
        updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.NOW },
      });
      await queryInterface.addIndex('LiveLocationSessions', ['chatId', 'isActive'], { name: 'idx_livelocation_chat_active' });
      await queryInterface.addIndex('LiveLocationSessions', ['userId', 'isActive'], { name: 'idx_livelocation_user_active' });
      await queryInterface.addIndex('LiveLocationSessions', ['messageId'], { name: 'idx_livelocation_message' });
      // Supports the expiry sweep job's WHERE isActive = true AND expiresAt <= NOW()
      await queryInterface.addIndex('LiveLocationSessions', ['expiresAt'], { name: 'idx_livelocation_expires' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('LiveLocationSessions').catch(() => {});
  },
};
