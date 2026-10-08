export async function expectedHeatmapColor(page, tone, magnitude, annual = false) {
  return page.evaluate(({tone,magnitude,annual})=>{
    const frame=document.querySelector('.app-frame');
    const positiveRed=frame.dataset.returnPalette==='red-up';
    const scale=annual ? 4 : 1;
    const level=magnitude < .03*scale ? 1 : magnitude < .08*scale ? 2 : magnitude < .15*scale ? 3 : 4;
    const reds=['#ef4a4a','#f72d2d','#bf2222','#9a1a1a'];
    const greens=['#18d57f','#1dc87a','#0c9a5a','#087443'];
    const useRed=tone==='positive' ? positiveRed : !positiveRed;
    const hex=(useRed ? reds : greens)[level-1];
    return `rgb(${parseInt(hex.slice(1,3),16)}, ${parseInt(hex.slice(3,5),16)}, ${parseInt(hex.slice(5,7),16)})`;
  },{tone,magnitude,annual});
}
