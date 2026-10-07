'use strict';
module.exports=(sequelize,DataTypes)=>{
 const MoneyContribution=sequelize.define('MoneyContribution',{
  id:{type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true},
  circleId:{type:DataTypes.UUID,allowNull:false,field:'circle_id'},
  contributorId:{type:DataTypes.INTEGER,allowNull:false,field:'contributor_id'},
  amount:{type:DataTypes.DECIMAL(15,2),allowNull:false},
  currency:{type:DataTypes.STRING(10),defaultValue:'KES'},
  method:{type:DataTypes.STRING(30),defaultValue:'mpesa'},
  paymentRef:{type:DataTypes.STRING(255),allowNull:true,field:'payment_ref'},
  status:{type:DataTypes.ENUM('pending','paid','failed','refunded'),defaultValue:'pending'},
  note:{type:DataTypes.STRING(255),allowNull:true},
  metadata:{type:DataTypes.JSONB,defaultValue:{}},
  createdAt:{type:DataTypes.DATE,field:'createdAt'},updatedAt:{type:DataTypes.DATE,field:'updatedAt'}
 },{tableName:'money_contributions',timestamps:true,underscored:true});
 MoneyContribution.associate=models=>{if(models.MoneyCircle)MoneyContribution.belongsTo(models.MoneyCircle,{foreignKey:'circleId',as:'circle',constraints:false});};
 return MoneyContribution;
};