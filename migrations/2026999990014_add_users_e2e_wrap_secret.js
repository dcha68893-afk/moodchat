'use strict';
/**
 * E2E-WRAP-SECRET FIX (Phase 5 forensic audit)
 * ---------------------------------------------
 * Root cause of "Manual login fails encryption, Google login works": the
 * frontend derives the key that wraps/unwraps a user's local E2E private key
 * from a password stashed in sessionStorage at login (js/e2e-encryption.js).
 * Manual login has a real typed password to stash. Google login never did —
 * loginWithGoogle() generates a random password server-side and never
 * returns it — so the frontend never called KynectaE2E.init() for Google
 * users at all, and message encryption silently fell back to plaintext for
 * every Google-authenticated account. Manual users hit the real crypto path
 * and could hit a genuine failure there instead.
 *
 * This column gives every account (regardless of login method) a stable,
 * random, server-issued secret independent of the account password, so both
 * login paths can derive the exact same kind of local wrap key. Lazily
 * populated by authService.js's _ensureE2EWrapSecret() on next login for
 * existing accounts — this migration only adds the column.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Users');
    if (!table.e2eWrapSecret) {
      await queryInterface.addColumn('Users', 'e2eWrapSecret', {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'e2eWrapSecret').catch(() => {});
  },
};
