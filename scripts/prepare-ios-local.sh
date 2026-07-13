#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -z "${CF_CLIENT_ID:-}" || -z "${CF_CLIENT_SECRET:-}" ]]; then
  echo "Missing CF_CLIENT_ID or CF_CLIENT_SECRET."
  echo "Export the Cloudflare Access service token values before running this script."
  exit 1
fi

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild was not found. Install Xcode, open it once, then run:"
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

XCODE_MAJOR="$(xcodebuild -version | awk '/^Xcode / { split($2, v, "."); print v[1] }')"
if [[ -z "$XCODE_MAJOR" || "$XCODE_MAJOR" -lt 26 ]]; then
  echo "Xcode 26 or later is required. Found:"
  xcodebuild -version
  exit 1
fi

if ! command -v pod >/dev/null 2>&1; then
  echo "CocoaPods was not found. Install it on the Mac, for example:"
  echo "  sudo gem install cocoapods"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ ! -d ios ]]; then
  npx cap add ios
fi

npx @capacitor/assets generate --ios
npx cap sync ios

cat > ios/App/App/CFViewController.swift <<'SWIFT'
import UIKit
import Capacitor
import WebKit

class CFViewController: CAPBridgeViewController, WKNavigationDelegate {

  private let cfId  = "CF_ID_PLACEHOLDER"
  private let cfSec = "CF_SEC_PLACEHOLDER"

  override func viewDidLoad() {
    super.viewDidLoad()
    webView?.navigationDelegate = self
    webView?.allowsBackForwardNavigationGestures = false
    if #available(iOS 16.4, *) {
      webView?.isInspectable = true
    }
    let js = """
    (function(){
      const id='\(self.cfId)',sec='\(self.cfSec)',h='automation.509electric.com';

      const orig=window.fetch.bind(window);
      window.fetch=function(i,o){
        let u=typeof i==='string'?i:(i&&i.url)||'';
        if(u.includes(h)||u.startsWith('/')){
          o=o||{};o.headers=Object.assign({},o.headers||{},
          {'CF-Access-Client-Id':id,'CF-Access-Client-Secret':sec});
        }
        return orig(i,o);
      };

      const imgDesc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      Object.defineProperty(HTMLImageElement.prototype,'src',{
        set:function(url){
          if(url&&(url.includes(h)||(url.startsWith('/')&&!url.startsWith('//')))
             &&!url.startsWith('blob:')&&!url.startsWith('data:')){
            if(/[?&]_k=/.test(url)){ imgDesc.set.call(this,url); return; }
            const el=this;
            const full=url.startsWith('/')?'https://'+h+url:url;
            const prevBlob=el._cfBlob;
            window.fetch(full)
              .then(r=>r.blob())
              .then(b=>{
                const newBlob=URL.createObjectURL(b);
                imgDesc.set.call(el,newBlob);
                el._cfBlob=newBlob;
                const cleanup=()=>{
                  if(prevBlob&&prevBlob!==newBlob){
                    try{URL.revokeObjectURL(prevBlob);}catch(_){}
                  }
                };
                el.addEventListener('load',cleanup,{once:true});
                el.addEventListener('error',cleanup,{once:true});
              })
              .catch(()=>{imgDesc.set.call(el,url);});
          } else { imgDesc.set.call(this,url); }
        },
        get:function(){return imgDesc.get.call(this);}
      });

      const setAttrOrig=Element.prototype.setAttribute;
      Element.prototype.setAttribute=function(name,value){
        if(this instanceof HTMLImageElement&&name&&name.toLowerCase()==='src'&&value){
          this.src=value;
          return;
        }
        return setAttrOrig.apply(this,arguments);
      };
    })();
    """
    let s=WKUserScript(source:js,injectionTime:.atDocumentStart,forMainFrameOnly:false)
    webView?.configuration.userContentController.addUserScript(s)
  }

  func webView(_ webView:WKWebView,decidePolicyFor action:WKNavigationAction,
               decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
    if action.navigationType == .backForward { decisionHandler(.allow); return }
    guard let url=action.request.url,
          url.host?.contains("509electric.com")==true,
          action.request.value(forHTTPHeaderField:"CF-Access-Client-Id")==nil
    else { decisionHandler(.allow); return }
    decisionHandler(.cancel)
    var r=URLRequest(url:url)
    r.setValue(cfId,forHTTPHeaderField:"CF-Access-Client-Id")
    r.setValue(cfSec,forHTTPHeaderField:"CF-Access-Client-Secret")
    webView.load(r)
  }
}
SWIFT

ruby - "$CF_CLIENT_ID" "$CF_CLIENT_SECRET" <<'RUBY'
id = ARGV[0]
secret = ARGV[1]
path = 'ios/App/App/CFViewController.swift'
text = File.read(path)
text = text.gsub('CF_ID_PLACEHOLDER', id).gsub('CF_SEC_PLACEHOLDER', secret)
File.write(path, text)
RUBY

find ios/App -name "*.storyboard" -print0 | xargs -0 sed -i '' \
  -e 's/customClass="CAPBridgeViewController"/customClass="CFViewController"/g' \
  -e 's/customClass="CFViewController" customModule="Capacitor"/customClass="CFViewController" customModule="App"/g'

ruby -e "require 'xcodeproj'" >/dev/null 2>&1 || gem install xcodeproj --no-document
ruby <<'RUBY'
require 'xcodeproj'
proj = Xcodeproj::Project.open('ios/App/App.xcodeproj')
target = proj.targets.first
grp = proj.main_group.find_subpath('App', true)
ref = grp.files.find { |f| f.path == 'CFViewController.swift' } || grp.new_file('CFViewController.swift')
unless target.source_build_phase.files_references.include?(ref)
  target.add_file_references([ref])
end
proj.save
RUBY

plist='ios/App/App/Info.plist'
/usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$plist"
/usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string 'Take job site photos'" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :NSCameraUsageDescription 'Take job site photos'" "$plist"
/usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryUsageDescription string 'Choose photos from your library'" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :NSPhotoLibraryUsageDescription 'Choose photos from your library'" "$plist"
/usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryAddUsageDescription string 'Save photos to your library'" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :NSPhotoLibraryAddUsageDescription 'Save photos to your library'" "$plist"
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string 'Record video with audio'" "$plist" 2>/dev/null || /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription 'Record video with audio'" "$plist"

echo "iOS project is ready."
echo "Open ios/App/App.xcworkspace in Xcode and run the App scheme on an iPhone simulator."
