/* newsFilter.js — stub (no external API by default) */
async function checkHighImpactWindow(symbol){
  // Return { isHighImpact:false } by default.
  // If you provide NEWS_API_KEY in .env, integrate here.
  return { isHighImpact:false, events:[] };
}
module.exports = { checkHighImpactWindow };
