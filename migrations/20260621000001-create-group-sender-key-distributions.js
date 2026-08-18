'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// GROUP E2E ENCRYPTION — Sender Keys distribution table.
//
// Design (matches how Signal/WhatsApp group encryption actually works,
// reusing the 1:1 ECDH infrastructure already built — see
// user_encryption_keys / src/routes/encryption.js):
//
//   1. Each group member generates their own random AES-256 "Sender Key"
//      for a specific group, client-side. This key never leaves the
//      device in plaintext.
//   2. To let every other current member decrypt messages sent under that
//      key, the owning member encrypts their Sender Key once per
//      recipient, using the EXISTING 1:1 ECDH shared secret between
//      themselves and that recipient (the same mechanism already used for
//      1:1 message encryption). That produces one row per
//      (groupId, ownerUserId, recipientUserId) — i.e. a fan-out, not a
//      single shared secret for the whole group.
//   3. To send a group message, a member encrypts it ONCE with their own
//      Sender Key and broadcasts that single ciphertext. Recipients
//      decrypt using whichever Sender Key distribution row matches
//      (groupId, senderId, theirOwnUserId).
//   4. On membership change (member removed/banned/left), every
//      OTHER remaining member must generate a NEW Sender Key and
//      redistribute it — old distribution rows for the departed key
//      generation get marked inactive so a removed member's already-
//      received distributions can't be reused for new messages.
//
// The server only ever stores/relays already-encrypted Sender Key
// material here — it cannot read it, the same property as message
// content itself.
module.exports = {
  async up(queryInterface, Sequelize) {
    // FIX (PROD-SCHEMA-DRIFT): guard against a partial prior run (this
    // migration creates a table + constraint + 2 indexes in one go — if a
    // prior deploy died partway through for an unrelated reason, retrying
    // would otherwise fail on "relation already exists").
    const tables = await queryInterface.showAllTables();
    if (tables.some(t => String(t).toLowerCase() === 'group_sender_key_distributions')) {
      console.log('[create-group-sender-key-distributions] table already exists — skipping.');
      return;
    }

    await queryInterface.createTable('group_sender_key_distributions', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      groupId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Groups', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // The member whose Sender Key this distribution carries.
      ownerUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // Who can decrypt THIS row — the Sender Key, encrypted specifically
      // for this recipient via the existing 1:1 ECDH channel.
      recipientUserId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // Monotonically increasing per (groupId, ownerUserId) — bumped every
      // time the owner rotates their Sender Key (membership change, manual
      // rotation, etc.). Lets recipients know which generation a given
      // incoming message's ciphertext was encrypted under.
      keyGeneration: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      // The Sender Key itself, encrypted for recipientUserId — same
      // {v,kid,iv,ct} JSON envelope shape used by 1:1 message encryption
      // (js/e2e-encryption.js), stored as text since it's just JSON.
      encryptedSenderKey: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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

    await queryInterface.addConstraint('group_sender_key_distributions', {
      fields: ['groupId', 'ownerUserId', 'recipientUserId', 'keyGeneration'],
      type: 'unique',
      name: 'group_sender_key_dist_unique'
    });

    // Fast lookup: "give me every active sender key distributed TO me in
    // this group" — what a client needs on joining/syncing to be able to
    // decrypt everyone else's messages.
    await queryInterface.addIndex('group_sender_key_distributions', ['groupId', 'recipientUserId', 'isActive'], {
      name: 'group_sender_key_dist_recipient_idx'
    });

    // Fast lookup: "what's my current key generation in this group" —
    // what a client needs before sending, to know whether it needs to
    // rotate/redistribute before encrypting a new message.
    await queryInterface.addIndex('group_sender_key_distributions', ['groupId', 'ownerUserId', 'isActive'], {
      name: 'group_sender_key_dist_owner_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('group_sender_key_distributions');
  }
};
