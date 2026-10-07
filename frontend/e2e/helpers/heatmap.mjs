export async function expectedHeatmapColor(page, tone, magnitude, annual = false) {
  return page.evaluate(({tone,magnitude,annual})=>{
    const styles=getComputedStyle(document.querySelector('.app-frame'));
    const channels=styles.getPropertyValue(`--return-${tone}-hs`).trim();
    const lightnessStart=parseFloat(styles.getPropertyValue('--heatmap-lightness-start'));
    const lightnessRange=parseFloat(styles.getPropertyValue('--heatmap-lightness-range'));
    const intensity=Math.min(1,magnitude/(annual ? .4 : .1));
    const lightness=Math.max(0,Math.min(100,lightnessStart+intensity*lightnessRange));
    const el=document.createElement('span');
    el.style.backgroundColor=`hsl(${channels} ${lightness}%)`;
    document.querySelector('.app-frame').append(el);
    const result=getComputedStyle(el).backgroundColor;el.remove();return result;
  },{tone,magnitude,annual});
}
