---
type: feature
scope: scan
date: 2026-07-13
docs_target: docs/USER_GUIDE.md#Scan a VIN, get the vehicle
---
Scan a VIN and get the whole vehicle. Point the camera at a car's door-jamb VIN barcode and Cobblr decodes it against the free NHTSA database, then mints a record already named "2003 Honda Accord" with make, model, year, body, and fuel filled in, the same one-tap flow a product barcode uses (a UPC still goes to the product catalogs; a VIN goes to the vehicle database, decided by the code's shape). You can still type a VIN into a vehicle form to fill the same fields. It's a suggestion you can double-check: only empty fields are touched, and a bad or partial VIN says so instead of guessing. Works on the shipped Vehicle Maintenance bundle and on any make/model/year table you build.

## docs

Scan a VIN, get the vehicle. A code that only *stands for* a thing gets handed to whatever decoder recognizes its shape and looked up against an outside source. The first is the **VIN**: point the camera at the door-jamb VIN barcode and Cobblr decodes it against NHTSA vPIC, minting a record already named "2003 Honda Accord" with make/model/year/body/fuel filled in, the same camera → inbox → confirm flow a product barcode uses (a UPC goes to the product catalogs, a VIN goes to vPIC; the code's shape decides). You can also type a VIN into a vehicle form and it fills the same fields on a complete VIN. Filled fields are a suggestion you double-check: only empty fields are touched, never overwriting what you typed, and a bad/partial VIN says so. A vehicle table declares which fields the decode targets, so it works on the shipped Vehicle Maintenance bundle and any make/model/year table you build. Only the VIN leaves your workspace, to a US-government endpoint.
