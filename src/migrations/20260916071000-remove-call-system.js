'use strict';
module.exports={
 async up(queryInterface){
   // Calls are no longer part of Necpra. Drop the legacy call history table
   // after the application routes/services/models have been removed.
   await queryInterface.sequelize.query('DROP TABLE IF EXISTS "Calls" CASCADE;');
 },
 async down(){
   // Intentionally no recreation of the retired call subsystem.
 }
};
