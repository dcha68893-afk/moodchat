'use strict';
module.exports=(sequelize,DataTypes)=>{
 const MoneyCircle=sequelize.define('MoneyCircle',{
  id:{type:DataTypes.UUID,defaultValue:DataTypes.UUIDV4,primaryKey:true},
  ownerId:{type:DataTypes.INTEGER,allowNull:false,field:'owner_id'},
  name:{type:DataTypes.STRING(120),allowNull:false},
  purpose:{type:DataTypes.STRING(255),allowNull:true},
  type:{type:DataTypes.ENUM('chama','family','trip','event','emergency','project','purchase','other'),defaultValue:'other'},
  targetAmount:{type:DataTypes.DECIMAL(15,2),defaultValue:0,field:'target_amount'},
  collectedAmount:{type:DataTypes.DECIMAL(15,2),defaultValue:0,field:'collected_amount'},
  currency:{type:DataTypes.STRING(10),defaultValue:'KES'},
  status:{type:DataTypes.ENUM('active','completed','cancelled'),defaultValue:'active'},
  settings:{type:DataTypes.JSONB,defaultValue:{}},
  createdAt:{type:DataTypes.DATE,field:'createdAt'},updatedAt:{type:DataTypes.DATE,field:'updatedAt'}
 },{tableName:'money_circles',timestamps:true,underscored:true});
 MoneyCircle.associate=models=>{if(models.Users)MoneyCircle.belongsTo(models.Users,{foreignKey:'ownerId',as:'owner',constraints:false});};
 return MoneyCircle;
};