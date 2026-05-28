require('dotenv').config();
const mongoose = require('mongoose');

const uri = process.env.MONGO_URI;

mongoose.connect(uri)
  .then(() => {
    console.log('✅ Conexión exitosa a MongoDB Atlas');
    console.log(`Base de datos activa: ${mongoose.connection.name}`);
  })
  .catch(err => {
    console.error('❌ Error de conexión a MongoDB:');
    console.error(`Mensaje: ${err.message}`);
    console.error(`Código: ${err.code || 'N/A'}`);
  });
