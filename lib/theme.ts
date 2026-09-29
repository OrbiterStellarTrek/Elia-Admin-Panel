export const themeStorageKey = "elia-panel-theme"

// Apply the saved theme before the first paint, including on static exports.
export const themeScript = `(function(){var t="system";try{var v=localStorage.getItem("${themeStorageKey}");if(v==="light"||v==="dark"||v==="system")t=v}catch(e){}var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)})()`
