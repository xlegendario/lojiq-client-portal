Screenshots for /guide

File names, exactly like this:

    shot-01.png          taken on a normal screen
    shot-01-mobile.png   taken on a phone

They go in this folder. A slot on the guide turns into the image the moment
the file exists, so the page stays readable while they are being made.

If the mobile version is missing, the desktop one is shown on phones too.
That works, but it renders small - which is the reason for having both.

png or jpg are both fine. Say so if you use jpg and the references get
updated. Take the desktop shots at the same window width, so the page reads
evenly.


WHAT EACH ONE SHOWS

shot-01   Signing in
    The login screen, with the Forgot password? button in frame.
    Caption on the page: "Where you start."

shot-02   The shop
    The shop with a product open, size list and the Buy / Offer buttons in frame.
    Caption on the page: "One price per size, all in."

shot-03   Manual Orders
    Manual Orders with the Offers tab open and one row carrying Accept / Counter / Deny.
    Caption on the page: "Where an offer waits for your answer."

shot-04   Store Orders
    Store Orders with the Offers tab open and one row carrying Accept / Counter / Deny.
    Caption on the page: "Same answer, on an order you did not place."

shot-05   Store Orders
    Store Orders with the Issues tab open, and the tab visible in the sidebar with its count.
    Caption on the page: "The one tab that only exists on this side."

shot-06   Returns
    The Returns section with one return open.
    Caption on the page: "Returns, from registration to closed."

shot-07   Finance
    Open Payments with a few rows selected and the pay button in frame.
    Caption on the page: "Several open amounts, one payment."


NOTE

shot-04 and shot-05 can only be taken while logged in as a store on 'api' or
'both', and shot-06 needs one too. A manual-only store has no Store Orders
section and no Returns section in its portal - the guide shows them to
everyone, but the screens still have to come from a store that has them.

SCREENSHOT-SNIPPETS.txt in this folder has an inspect() line per shot, so you
can grab the exact node instead of cropping by hand.
