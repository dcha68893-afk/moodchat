'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS marketplace_accommodation_bookings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listing_id UUID NOT NULL,
        guest_id INTEGER NOT NULL,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        rooms INTEGER NOT NULL DEFAULT 1 CHECK (rooms > 0),
        guests INTEGER NOT NULL DEFAULT 1 CHECK (guests > 0),
        status VARCHAR(20) NOT NULL DEFAULT 'confirmed',
        total_price DECIMAL(12,2) NOT NULL DEFAULT 0,
        currency VARCHAR(10) NOT NULL DEFAULT 'KES',
        guest_note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_accommodation_booking_listing_dates
        ON marketplace_accommodation_bookings (listing_id, check_in, check_out, status);
      CREATE INDEX IF NOT EXISTS idx_accommodation_booking_guest
        ON marketplace_accommodation_bookings (guest_id, created_at DESC);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS marketplace_accommodation_bookings;');
  },
};
