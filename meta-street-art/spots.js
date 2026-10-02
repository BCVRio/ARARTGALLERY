// London street art spots and walking tours.
// Street art changes constantly: walls get repainted, pieces get buffed.
// Coordinates point to the wall / street, not to a single guaranteed piece.
window.SPOTS = [
  {
    id: 'leake-street',
    name: 'Leake Street Graffiti Tunnel',
    area: 'Waterloo',
    lat: 51.5019, lng: -0.1145,
    tags: ['legal wall', 'tunnel'],
    blurb: "You're at Leake Street, the 300 metre tunnel under Waterloo station. Banksy launched it as a legal graffiti space with his Cans Festival in 2008, and the walls are repainted almost daily. If you see someone painting, stop and watch: it's one of the few places in London where it's allowed.",
  },
  {
    id: 'undercroft',
    name: 'Southbank Undercroft',
    area: 'South Bank',
    lat: 51.5068, lng: -0.1167,
    tags: ['skate spot', 'tags'],
    blurb: "This is the Southbank Undercroft, under the Queen Elizabeth Hall. Skaters have used it since the 1970s, and its layered tags and throw-ups were saved from redevelopment by a long public campaign in 2014.",
  },
  {
    id: 'brick-lane',
    name: 'Brick Lane',
    area: 'Shoreditch & Spitalfields',
    lat: 51.5218, lng: -0.0718,
    tags: ['murals', 'paste-ups'],
    blurb: "Welcome to Brick Lane, the heart of East London street art. Look up as well as along: big murals cover the side walls, and the shutters, doorways and drainpipes hide paste-ups, stencils and small sculptures.",
  },
  {
    id: 'hanbury-street',
    name: 'Hanbury Street',
    area: 'Shoreditch & Spitalfields',
    lat: 51.5205, lng: -0.0705,
    tags: ['murals'],
    blurb: "Hanbury Street, just off Brick Lane, is home to some of the area's largest murals. The Belgian artist ROA painted his famous giant crane bird here in 2010, which helped put this street on the map.",
  },
  {
    id: 'redchurch',
    name: 'Redchurch & Ebor Street',
    area: 'Shoreditch',
    lat: 51.5240, lng: -0.0745,
    tags: ['murals', 'stencils'],
    blurb: "Redchurch Street and the lanes around Ebor Street. The side walls and car parks here rotate big commissioned pieces, while the alleys are full of stickers and stencils.",
  },
  {
    id: 'village-underground',
    name: 'Village Underground Wall',
    area: 'Shoreditch',
    lat: 51.5245, lng: -0.0786,
    tags: ['rotating wall'],
    blurb: "This is the Village Underground wall on Holywell Lane. Look for the old tube carriages on the roof above. The giant wall below gets a new piece every few months, often from internationally known artists.",
  },
  {
    id: 'rivington',
    name: 'Rivington Street',
    area: 'Shoreditch',
    lat: 51.5260, lng: -0.0800,
    tags: ['murals', 'history'],
    blurb: "Rivington Street, one of the original Shoreditch street art streets. Banksy, Eine and many others have painted around here since the early 2000s, and the walls and shutters still change constantly.",
  },
  {
    id: 'whitecross',
    name: 'Whitecross Street',
    area: 'Islington',
    lat: 51.5233, lng: -0.0935,
    tags: ['murals', 'market'],
    blurb: "Whitecross Street, home of a weekday food market and the Whitecross Street Party, which has filled these walls with colourful murals for years.",
  },
  {
    id: 'shop-until-you-drop',
    name: 'Banksy, "Shop Until You Drop"',
    area: 'Mayfair',
    lat: 51.5101, lng: -0.1436,
    tags: ['Banksy'],
    blurb: "Look up at the corner of Bruton Lane. That's Banksy's Shop Until You Drop from 2011, a woman falling from a building, still clutching her shopping trolley. It's one of the few Banksy pieces left in central London.",
  },
  {
    id: 'amy-winehouse',
    name: 'Amy Winehouse Mural',
    area: 'Camden',
    lat: 51.5370, lng: -0.1405,
    tags: ['portrait', 'tribute'],
    blurb: "This is Pegasus's tribute to Amy Winehouse on Bayham Street, just round the corner from the Camden pubs and venues she loved.",
  },
  {
    id: 'camden-lock',
    name: 'Camden Market & Lock',
    area: 'Camden',
    lat: 51.5414, lng: -0.1460,
    tags: ['murals', 'shopfronts'],
    blurb: "Camden Market and the lock. Look out for the giant 3D shop-front sculptures on the High Street and the painted walls along the canal towpath.",
  },
  {
    id: 'hackney-wick',
    name: 'Hackney Wick & Fish Island',
    area: 'Hackney Wick',
    lat: 51.5435, lng: -0.0230,
    tags: ['canal', 'graffiti'],
    blurb: "Hackney Wick and Fish Island. Old warehouses and the canal walls here hold some of London's densest graffiti. Walk the towpath and the side streets off Wallis Road.",
  },
  {
    id: 'bowie',
    name: 'David Bowie Mural',
    area: 'Brixton',
    lat: 51.4625, lng: -0.1142,
    tags: ['portrait', 'tribute'],
    blurb: "You're facing the David Bowie mural by Jimmy C, opposite Brixton station. Bowie was born nearby in 1947. After he died in 2016 this wall became a shrine of flowers and messages. The mural is now protected behind a clear screen.",
  },
];

window.TOURS = [
  {
    id: 'shoreditch',
    name: 'Shoreditch Loop',
    desc: 'Brick Lane to Whitecross St · about 2.5 km',
    stops: ['hanbury-street', 'brick-lane', 'redchurch', 'village-underground', 'rivington', 'whitecross'],
  },
  {
    id: 'southbank',
    name: 'South Bank',
    desc: 'Leake Street tunnel and the Undercroft · about 1 km',
    stops: ['leake-street', 'undercroft'],
  },
  {
    id: 'camden',
    name: 'Camden',
    desc: 'Amy Winehouse mural to Camden Lock · about 1 km',
    stops: ['amy-winehouse', 'camden-lock'],
  },
];

// Simulated start points for demo mode (nearest station to the first stop).
window.DEMO_STARTS = [
  { name: 'Liverpool Street', lat: 51.5178, lng: -0.0823 },
  { name: 'Waterloo', lat: 51.5031, lng: -0.1132 },
  { name: 'Camden Town', lat: 51.5392, lng: -0.1426 },
  { name: 'Brixton Village', lat: 51.4606, lng: -0.1118 },
  { name: 'Bond Street', lat: 51.5142, lng: -0.1494 },
  { name: 'Hackney Wick', lat: 51.5434, lng: -0.0247 },
  { name: 'Barbican', lat: 51.5204, lng: -0.0979 },
];
