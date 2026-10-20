const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {blocks}=require('./download-blocks.cjs');
const root=path.resolve(__dirname,'../../toolchain');fs.mkdirSync(root,{recursive:true});
async function get(url,name,checksum,algorithm='sha256'){
 const file=path.join(root,name);const matches=()=>fs.existsSync(file)&&crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex')===checksum;
 if(matches())return;await blocks(url,name);if(!matches())throw Error(name+': checksum failed');
}
(async()=>{
 if(!fs.existsSync(path.join(root,'jdk-17'))){
  const r=await fetch('https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows');const [jdk]=await r.json();
  fs.writeFileSync(path.join(root,'jdk-meta.json'),JSON.stringify({folder:jdk.release_name,sha256:jdk.binary.package.checksum}));
  await get(jdk.binary.package.link,'jdk.zip',jdk.binary.package.checksum);
 }
 if(!fs.existsSync(path.join(root,'gradle-8.13'))){const sum=(await(await fetch('https://downloads.gradle.org/distributions/gradle-8.13-bin.zip.sha256')).text()).trim();await get('https://downloads.gradle.org/distributions/gradle-8.13-bin.zip','gradle.zip',sum)}
 const xml=await(await fetch('https://dl.google.com/android/repository/repository2-3.xml')).text();
 for(const [pkg,name,target]of [['cmdline-tools;latest','sdk.zip','cmdline-tools/latest/bin/sdkmanager.bat'],['platforms;android-35','platform35.zip','platforms/android-35/android.jar'],['build-tools;35.0.0','buildtools35.zip','build-tools/35.0.0/aapt2.exe'],['platform-tools','platformtools.zip','platform-tools/adb.exe']]){
  if(fs.existsSync(path.join(root,'android-sdk',target)))continue;
  const start=xml.indexOf('<remotePackage path="'+pkg+'"');if(start<0)throw Error('SDK package not found: '+pkg);
  const part=xml.slice(start,xml.indexOf('</remotePackage>',start));const archives=[...part.matchAll(/<archive>([\s\S]*?)<\/archive>/g)];
  const archive=archives.find(a=>a[1].includes('<host-os>windows</host-os>'))||archives.find(a=>!a[1].includes('<host-os>'));if(!archive)throw Error('No Windows SDK archive');
  const url=archive[1].match(/<url>([^<]+)/)[1],sum=archive[1].match(/<checksum[^>]*>([^<]+)/)[1];
  await get('https://dl.google.com/android/repository/'+url,name,sum,'sha1');
 }
})().catch(e=>{console.error(e.message);process.exitCode=1});
