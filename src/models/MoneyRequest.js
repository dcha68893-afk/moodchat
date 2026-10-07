'use strict';
module.exports=(sequelize,DataTypes)=>{
 const MoneyRequest=sequelize.define('MoneyRequest',{
  id:{type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true},
  requesterId:{type:DataTypes.INTEGER,allowNull:false,field:'requester_id'},
  recipientUserId:{type:DataTypes.INTEGER,allowNull:true,field:'recipient_user_id'},
  recipientPhone:{type:DataTypes.STRING(30),allowNull:false,field:'recipient_phone'},
  amount:{type:DataTypes.DECIMAL(15,2),allowNull:false},
  currency:{type:DataTypes.STRING(10),defaultValue:'KES'},
  purpose:{type:DataTypes.STRING(255),allowNull:true},
  status:{type:DataTypes.ENUM('requested','paid','cancelled','expired'),defaultValue:'requested'},
  expiresAt:{type:DataTypes.DATE,allowNull:true,field:'expires_at'},
  paymentRef:{type:DataTypes.STRING(255),allowNull:true,field:'payment_ref'},
  metadata:{type:DataTypes.JSONB,defaultValue:{}},
  idempotencyKey:{type:DataTypes.STRING(120),allowNull:true,field:'idempotency_key'},
  createdAt:{type:DataTypes.DATE,field:'createdAt'},updatedAt:{type:DataTypes.DATE,field:'updatedAt'}
 },{tableName:'money_requests',timestamps:true,underscored:true});
 return MoneyRequest;
};