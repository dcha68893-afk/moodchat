'use strict';
// ContactMessage.js — durable storage for "Contact Us" submissions (login
// page + Settings). Always written first, before any attempt to also drop
// the message into the admin's normal chat inbox, so a submission is never
// lost even if the chat-delivery step fails for any reason.
module.exports = (sequelize, DataTypes) => {
  const ContactMessage = sequelize.define('ContactMessage', {
    id:         { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    senderId:   { type: DataTypes.INTEGER, allowNull: true, field: 'sender_id' }, // null if not logged in
    name:       { type: DataTypes.STRING(150), allowNull: false },
    email:      { type: DataTypes.STRING(255), allowNull: false },
    subject:    { type: DataTypes.STRING(50), allowNull: false },
    message:    { type: DataTypes.TEXT, allowNull: false },
    status:     { type: DataTypes.ENUM('new', 'read', 'replied'), defaultValue: 'new', allowNull: false },
    deliveredToChat: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'delivered_to_chat' },
    chatId:     { type: DataTypes.INTEGER, allowNull: true, field: 'chat_id' },
    createdAt:  { type: DataTypes.DATE, field: 'created_at' },
    updatedAt:  { type: DataTypes.DATE, field: 'updated_at' },
  }, {
    tableName: 'contact_messages',
    timestamps: true,
    underscored: true,
    indexes: [{ fields: ['status'] }, { fields: ['created_at'] }],
  });

  ContactMessage.associate = function (models) {
    if (models.Users) ContactMessage.belongsTo(models.Users, { foreignKey: 'senderId', as: 'sender', constraints: false });
  };

  return ContactMessage;
};
