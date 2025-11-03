/* cloudSync.js - stub for cloud persistence */
module.exports = {
  saveSignal: async (sig) => {
    if(process.env.CLOUD_SAVE === 'true' && process.env.CLOUD_ENDPOINT){
      // implement actual HTTP POST with CLOUD_API_KEY if required
    }
    return true;
  }
};
