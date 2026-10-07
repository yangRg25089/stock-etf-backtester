export async function expectedHeatmapColor(page, color, magnitude, annual = false) {
  return page.evaluate(({color,magnitude,annual})=>{
    const el=document.createElement('span');
    el.style.backgroundColor='color-mix(in srgb, '+color+' '+(10+Math.min(1,magnitude/(annual ? .4 : .1))*32)+'%, var(--app-surface))';
    document.querySelector('.app-frame').append(el);
    const result=getComputedStyle(el).backgroundColor;el.remove();return result;
  },{color,magnitude,annual});
}

