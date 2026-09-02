'use strict';

/**
 * FIX: production error `invalid input value for enum enum_notifications_type:
 * "new_message"` (SequelizeDatabaseError out of NotificationService.createNotification,
 * called from messageDeliveryService.js:420 via createFromTemplate('new_message', ...)).
 *
 * Root cause, confirmed by tracing (not guessed): notificationService.js's
 * getNotificationTemplate() has always set `type` to the template name itself
 * for 8 templates (new_message, message_reaction, message_reply,
 * status_mention, status_like, status_comment, status_question_answer,
 * on_this_day), but the Notification model's DataTypes.ENUM allow-list --
 * and therefore the live Postgres enum, since the Notifications table has
 * never had its own migration and was created purely by sequelize.sync()
 * off that model definition -- never included those values. Every one of
 * those 8 template calls has been throwing at the DB layer and getting
 * silently swallowed by a .catch(() => {}) at the call site, so affected
 * recipients never received the in-app Notification row or realtime push
 * (the message itself still delivers via the separate WebSocket path, which
 * is why this went unnoticed for a while).
 *
 * The Notifications table/enum name's exact case is not guessable from the
 * model alone (an existing precedent migration for Messages.type hardcodes
 * "enum_Messages_type", but this table's error surfaced as the *lowercase*
 * "enum_notifications_type" -- a different casing -- so this migration looks
 * up the real enum type name from Postgres's own catalog instead of
 * assuming it, then ALTER TYPE ... ADD VALUE for each missing label.
 *
 * Postgres requires ALTER TYPE ... ADD VALUE to run outside a transaction
 * block (same constraint noted in
 * migrations/2026999990003_add_poll_viewonce_message_types.js) --
 * queryInterface.sequelize.query() here runs outside the migration's
 * implicit transaction wrapper since no `transaction` option is passed.
 *
 * @type {import('sequelize-cli').Migration}
 */

const NEW_VALUES = [
  'new_message',
  'message_reaction',
  'message_reply',
  'status_mention',
  'status_like',
  'status_comment',
  'status_question_answer',
  'on_this_day',
];

async function findNotificationsTypeEnumName(sequelize) {
  const [rows] = await sequelize.query(`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_attribute a ON a.atttypid = t.oid
    JOIN pg_class c ON a.attrelid = c.oid
    WHERE c.relname ILIKE 'notifications' AND a.attname = 'type'
    LIMIT 1;
  `);
  return rows && rows[0] && rows[0].typname;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    let typeName = await findNotificationsTypeEnumName(sequelize);
    if (!typeName) {
      // Fallback to Sequelize's default naming pattern if the catalog
      // lookup somehow finds nothing (e.g. table not created yet).
      typeName = 'enum_Notifications_type';
    }

    const addValueIfMissing = async (value) => {
      try {
        await sequelize.query(
          `ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value}';`
        );
      } catch (err) {
        // IF NOT EXISTS is supported on PG 12+; older versions throw
        // duplicate_object which we can safely ignore.
        if (!/already exists/i.test(err.message)) {
          console.warn(`[migration] Could not add enum value '${value}' to ${typeName}:`, err.message);
        }
      }
    };

    for (const value of NEW_VALUES) {
      await addValueIfMissing(value);
    }
  },

  async down() {
    // Postgres does not support removing enum values without recreating the
    // type and rewriting every row that references it. Treated as a
    // forward-only migration; down is intentionally a no-op.
  },
};
