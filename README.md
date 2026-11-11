# Rally Route Planner

Plans a scoring route for a motorcycle bonus rally. Drop in the rally book (PDF), bonus CSV and/or GPX, enter your fuel range, speed and mpg, and it searches for the highest-scoring route that respects time windows, fuel range and the finish deadline.

Open it: https://tylermisok.github.io/rally-route-planner/

## Privacy

Rally files are read in your browser and never uploaded. Some things do leave your device:

- To measure road distances, the coordinates of the bonuses and of your start and finish points (not names or points) are sent to the public OSRM routing server at router.project-osrm.org. If you set the start on the map at your home, that location is sent.
- Map tiles come from Esri, and fonts from Google Fonts. Like any website, those services see your IP address and which map area you view.

Settings and measured distances are saved in your browser's local storage, on your device only.

## Building

Edit `engine.js` (parsing, routing model, optimizer), `app.js` (UI) or `index.template.html`, then run `python3 build.py`. It inlines both scripts into `index.html`.

Route estimates come from OSRM drive times and your average speed. They do not model traffic, weather or stops beyond what you enter. Always check the plan against the rally book.
