// Adult / NSFW sites blocked by the unsafe-links rule (a subdomain counts too). On top of this list,
// linkSafety.js also catches the adult-only TLDs (.xxx .porn .sex .adult) and addresses built from
// obvious words ("porn", "hentai", "nsfw", "xxx"…), so new and copycat sites are caught as well.
// Servers can still allow one with the approved list, and channels marked NSFW skip the check.

// Tube sites
const TUBES = [
  'pornhub.com', 'pornhub.org', 'pornhubpremium.com', 'xvideos.com', 'xvideos2.com', 'xvideos.es', 'xnxx.com', 'xnxx.tv', 'xnxx.health',
  'xhamster.com', 'xhamster.desi', 'xhamster2.com', 'xhamster3.com', 'xhamsterlive.com', 'redtube.com', 'redtube.net', 'youporn.com',
  'youporngay.com', 'tube8.com', 'spankbang.com', 'spankbang.party', 'eporner.com', 'tnaflix.com', 'empflix.com', 'drtuber.com',
  'txxx.com', 'hclips.com', 'hdzog.com', 'hotmovs.com', 'upornia.com', 'voyeurhit.com', 'tubepornclassic.com', 'vjav.com', 'thegay.com',
  'porntrex.com', 'pornone.com', 'porndig.com', 'porn300.com', 'porn.com', 'pornerbros.com', 'pornoxo.com', 'pornhat.com', 'pornhd.com',
  'pornhd8k.net', 'porntube.com', 'porntop.com', 'pornobae.com', 'pornomovies.com', 'pornrewind.com', 'porngo.com', 'pornjam.com',
  'pornky.com', 'pornktube.com', 'pornmaki.com', 'pornwhite.com', 'pornzog.com', 'porntn.com', 'pornfind.org', 'pornburst.xxx',
  'motherless.com', 'beeg.com', 'sunporno.com', 'yourporn.sexy', 'sxyprn.com', 'thumbzilla.com', 'youjizz.com', 'heavy-r.com',
  'efukt.com', 'daftsex.com', 'hqporner.com', 'fapster.xxx', 'fapvid.com', 'fapnado.com', 'fapdu.com', 'faphouse.com', 'tubegalore.com',
  'alohatube.com', 'anysex.com', 'ashemaletube.com', 'bellesa.co', 'bitporno.com', 'camwhores.tv', 'camwhores.video', 'cliphunter.com',
  'collectionofbestporn.com', 'definebabe.com', 'fuq.com', 'fux.com', 'gotporn.com', 'hellporno.com', 'hotscope.tv', 'ixxx.com',
  'jizzbunker.com', 'keezmovies.com', 'lobstertube.com', 'luxuretv.com', 'manporn.xxx', 'mofosex.com', 'noodlemagazine.com',
  'nuvid.com', 'okxxx1.com', 'perfectgirls.net', 'pervclips.com', 'proporn.com', 'ruleporn.com', 'sexvid.xxx', 'shooshtime.com',
  'slutload.com', 'sleazyneasy.com', 'spankwire.com', 'sexu.com', 'sextvx.com', 'tiava.com', 'tubxporn.com', 'vporn.com', 'vidz7.com',
  'whoreshub.com', 'xbabe.com', 'xcafe.com', 'xfreehd.com', 'xgroovy.com', 'xmegadrive.com', 'xozilla.com', 'xxxbunker.com',
  'xxxymovies.com', 'yespornplease.com', 'yeptube.com', 'youav.com', 'zbporn.com', 'freeones.com', 'iceporn.com', 'pornolab.net',
  'xtapes.to', 'paradisehill.cc', 'fullporner.com', 'pornxp.com', 'netfapx.com', 'porndoe.com', 'sexyporn.com', 'theporndude.com',
  'pornmd.com', 'pornpics.com', 'pornpics.de', 'pichunter.com', 'sex.com', 'sexstories.com', 'literotica.com', 'asstr.org',
  'mrdeepfakes.com', 'fapello.com', 'fapopedia.net', 'thothub.to', 'thothub.tv', 'coomer.su', 'coomer.party', 'kemono.su',
  'kemono.party', 'erome.com', 'erothots.co', 'hotgirl.asia', 'nudogram.com', 'influencersgonewild.com', 'leakedmodels.com',
  'simpcity.su', 'socialmediagirls.com', 'forum.xnxx.com', 'planetsuzy.org', 'vipergirls.to', 'imagefap.com', 'motherless.media'
];

// Cams and live shows
const CAMS = [
  'chaturbate.com', 'stripchat.com', 'bongacams.com', 'livejasmin.com', 'cam4.com', 'camsoda.com', 'myfreecams.com', 'flirt4free.com',
  'imlive.com', 'streamate.com', 'jerkmate.com', 'camster.com', 'xlovecam.com', 'cams.com', 'camcontacts.com', 'camwhores.com',
  'slutroulette.com', 'shagle.com', 'chatrandom.com', 'dirtyroulette.com', 'camgirl.com', 'camgirls.com', 'xcams.com', 'livesex.com',
  'sexcamly.com', 'camversity.com', 'cherry.tv', 'fansly.com', 'manyvids.com', 'clips4sale.com', 'iwantclips.com', 'loyalfans.com',
  'fancentro.com', 'justfor.fans', 'avn.com', 'avnstars.com', 'modelhub.com', 'pornhubmodels.com', 'onlyfans.com', 'fanvue.com',
  'fapello.su', 'unfiltrd.com', 'admireme.vip', 'ismygirl.com', 'mym.fans', 'fanfix.io', 'fansone.co', 'scrile.com', 'pocketstars.com'
];

// Studios and pay sites
const STUDIOS = [
  'brazzers.com', 'bangbros.com', 'realitykings.com', 'naughtyamerica.com', 'mofos.com', 'digitalplayground.com', 'twistys.com',
  'vixen.com', 'blacked.com', 'tushy.com', 'deeper.com', 'slayed.com', 'blackedraw.com', 'tushyraw.com', 'evilangel.com',
  'kink.com', 'teamskeet.com', 'nubiles.net', 'nubilesporn.com', 'babes.com', 'puretaboo.com', 'adulttime.com', 'girlsway.com',
  'metart.com', 'metartx.com', 'sexart.com', 'x-art.com', 'hegre.com', 'joymii.com', 'playboy.com', 'playboyplus.com', 'penthouse.com',
  'hustler.com', 'hustlerunlimited.com', 'private.com', 'dorcelclub.com', 'marcdorcel.com', 'legalporno.com', 'analvids.com',
  'pornpros.com', 'fakehub.com', 'faketaxi.com', 'fakeagent.com', 'publicagent.com', 'mylf.com', 'familystrokes.com', 'sislovesme.com',
  'brattysis.com', 'momsteachsex.com', 'nfbusty.com', 'hentaied.com', 'pornfidelity.com', 'julesjordan.com', 'manuelferrara.com',
  'dogfartnetwork.com', 'wankz.com', 'czechav.com', 'czechcasting.com', 'woodmancastingx.com', 'castingcouch-x.com', 'exploitedcollegegirls.com',
  'girlsdoporn.com', 'pornfaze.com', 'killergram.com', 'pornworld.com', 'ddfnetwork.com', 'handsonhardcore.com', 'lubed.com',
  'passion-hd.com', 'tiny4k.com', 'exotic4k.com', 'castingcouch-hd.com', 'pornprosnetwork.com', 'spizoo.com', 'newsensations.com',
  'wicked.com', 'elegantangel.com', 'devilsfilm.com', 'zerotolerancefilms.com', 'burningangel.com', 'bang.com', 'letsdoeit.com',
  'vrporn.com', 'vrbangers.com', 'badoinkvr.com', 'naughtyamericavr.com', 'wankzvr.com', 'sexlikereal.com', 'czechvr.com', 'virtualrealporn.com',
  'men.com', 'seancody.com', 'helixstudios.com', 'corbinfisher.com', 'cockyboys.com', 'belamionline.com', 'randyblue.com',
  'falconstudios.com', 'nakedsword.com', 'gaytube.com', 'boyfriendtv.com', 'gaymaletube.com', 'shemalez.com', 'tranny.one', 'trannytube.tv',
  'groobygirls.com', 'tsplayground.com', 'transangels.com', 'gayporn.com', 'xtube.com', 'lesbea.com', 'girlfriendsfilms.com'
];

// Hentai, rule 34 and adult image boards
const HENTAI = [
  'nhentai.net', 'nhentai.to', 'nhentai.xxx', 'hentaihaven.xxx', 'hentaihaven.com', 'hanime.tv', 'hentai.tv', 'hentaimama.io',
  'hentaistream.com', 'hentaiworld.tv', 'hentaicity.com', 'hentai2read.com', 'hentaifox.com', 'hentaiera.com', 'hentaifor.net',
  'hentaigasm.com', 'hentaiplay.net', 'ohentai.org', 'e-hentai.org', 'exhentai.org', 'hitomi.la', 'tsumino.com', 'pururin.to',
  'fakku.net', 'luscious.net', 'simply-hentai.com', 'doujins.com', 'multporn.net', 'imhentai.xxx', 'hentaipaw.com', 'myreadingmanga.info',
  'rule34.xxx', 'rule34.paheal.net', 'rule34.us', 'rule34video.com', 'rule34.world', 'rule34hentai.net', 'rule34comic.party',
  'gelbooru.com', 'danbooru.donmai.us', 'yande.re', 'konachan.com', 'chan.sankakucomplex.com', 'realbooru.com',
  'xbooru.com', 'hypnohub.net', 'e621.net', 'e926.net', 'inkbunny.net', 'hentai-foundry.com', 'f95zone.to',
  'nutaku.net', 'nutaku.com', 'lewdzone.com', 'lewdgamer.com', 'erogames.com', 'sexemulator.com', 'animeidhentai.com',
  'hentaigo.net', 'hentaibar.com', 'hentaini.com', 'kissjav.com', 'javhd.com', 'javlibrary.com', 'javmost.com', 'javguru.com',
  'jav.guru', 'missav.com', 'missav.ws', 'supjav.com', 'javhub.net', 'javfinder.la', '91porn.com', 'tktube.com', '18comic.vip', 'jable.tv'
];

// Escorts, hookups and adult classifieds
const HOOKUPS = [
  'adultfriendfinder.com', 'ashleymadison.com', 'fling.com', 'benaughty.com', 'xmatch.com', 'alt.com', 'outpersonals.com',
  'iwantu.com', 'snapsext.com', 'sextfriend.com', 'fuckbook.com', 'fuckbookhookups.com', 'hookupcloud.com', 'onenightfriend.com',
  'instabang.com', 'easysex.com', 'sexfinder.com', 'sexsearch.com', 'meetnfuck.com', 'skipthegames.com', 'listcrawler.com',
  'eros.com', 'slixa.com', 'tryst.link', 'eurogirlsescort.com', 'escort-ads.com', 'escortdirectory.com', 'escortbabylon.net',
  'cityxguide.com', 'adultsearch.com', 'humpchies.com', 'rubmaps.com', 'massageplanet.net', 'theeroticreview.com', 'adultwork.com',
  'erotikmarkt.de', 'kaufmich.com', 'adultlook.com', 'bedpage.com', 'megapersonals.eu', 'doublelist.com',
  'feeld.co', 'pure.app', 'kinkd.com', 'fetlife.com', 'collarspace.com', 'recon.com', 'squirt.org', 'grindr.com', 'sniffies.com'
];

// Adult shops and toys
const SHOPS = [
  'adamandeve.com', 'lovehoney.com', 'lovehoney.co.uk', 'babeland.com', 'goodvibes.com', 'stockroom.com', 'extremerestraints.com',
  'fleshlight.com', 'lelo.com', 'we-vibe.com', 'lovense.com', 'bad-dragon.com', 'pinkcherry.com', 'edenfantasys.com', 'sextoy.com',
  'xr-brands.com', 'doc-johnson.com', 'nsfw.com', 'adultempire.com', 'gamelink.com', 'hotmovies.com', 'aebn.com', 'adultdvdempire.com'
];

const NSFW_DOMAINS = [...new Set([...TUBES, ...CAMS, ...STUDIOS, ...HENTAI, ...HOOKUPS, ...SHOPS])];

module.exports = { NSFW_DOMAINS };
