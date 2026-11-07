(() => {
  const failures=[];
  let checked=0;
  for(const width of [360,390,430]){
    window.designPreview.setWidth(width);
    for(const scene of window.SCENES){
      window.designPreview.render(scene.id,false);
      const phone=document.querySelector('#phone-host .phone');
      const content=phone.querySelector('.page-content');
      if(content.scrollWidth>content.clientWidth+1)failures.push({id:scene.id,width,overflow:content.scrollWidth-content.clientWidth});
      const bounds=phone.getBoundingClientRect();
      for(const el of phone.querySelectorAll('button,input,textarea,select')){
        const r=el.getBoundingClientRect();
        if(r.width && (r.left<bounds.left+3 || r.right>bounds.right-3))failures.push({id:scene.id,width,control:el.textContent.slice(0,35),bounds:[r.left-bounds.left,r.right-bounds.left]});
        if(el.tagName==='BUTTON' && !el.textContent.trim() && !el.getAttribute('aria-label'))failures.push({id:scene.id,width,unlabeledButton:true});
      }
      checked++;
    }
  }
  window.designPreview.setWidth(390);
  window.designPreview.render('pickup',false);
  return {checked,failures};
})();
