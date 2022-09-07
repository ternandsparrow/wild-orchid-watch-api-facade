#!/bin/bash
set -euo pipefail

theUuid=${1:?first param must be uuid to use}

cat << HEREDOC
{
  "latitude": -34.924175892671144,
  "longitude": 138.6099316040606,
  "observed_on_string": "2022-09-07T03:39:20.884Z",
  "species_guess": "loadtest $(date +%s)",
  "observation_field_values_attributes": {
    "0": {
      "observation_field_id": 39,
      "value": "Terrestrial"
    },
    "1": {
      "observation_field_id": 43,
      "value": "Not collected"
    },
    "2": {
      "observation_field_id": 46,
      "value": "Not collected"
    },
    "3": {
      "observation_field_id": 47,
      "value": "Not collected"
    },
    "4": {
      "observation_field_id": 75,
      "value": "No"
    },
    "5": {
      "observation_field_id": 76,
      "value": "No"
    },
    "6": {
      "observation_field_id": 77,
      "value": "No"
    },
    "7": {
      "observation_field_id": 78,
      "value": "No"
    },
    "8": {
      "observation_field_id": 79,
      "value": "No"
    },
    "9": {
      "observation_field_id": 80,
      "value": "No"
    },
    "10": {
      "observation_field_id": 81,
      "value": "No"
    },
    "11": {
      "observation_field_id": 102,
      "value": "No"
    },
    "12": {
      "observation_field_id": 51,
      "value": "Exact"
    },
    "13": {
      "observation_field_id": 53,
      "value": 1
    },
    "14": {
      "observation_field_id": 50,
      "value": "Not collected"
    },
    "15": {
      "observation_field_id": 111,
      "value": "Not collected"
    },
    "16": {
      "observation_field_id": 63,
      "value": "No"
    },
    "17": {
      "observation_field_id": 64,
      "value": "No"
    },
    "18": {
      "observation_field_id": 65,
      "value": "No"
    },
    "19": {
      "observation_field_id": 66,
      "value": "No"
    },
    "20": {
      "observation_field_id": 67,
      "value": "No"
    },
    "21": {
      "observation_field_id": 68,
      "value": "No"
    },
    "22": {
      "observation_field_id": 62,
      "value": "Not collected"
    },
    "23": {
      "observation_field_id": 59,
      "value": "Not collected"
    },
    "24": {
      "observation_field_id": 103,
      "value": "No"
    },
    "25": {
      "observation_field_id": 104,
      "value": "No"
    },
    "26": {
      "observation_field_id": 105,
      "value": "No"
    },
    "27": {
      "observation_field_id": 106,
      "value": "No"
    },
    "28": {
      "observation_field_id": 107,
      "value": "No"
    },
    "29": {
      "observation_field_id": 108,
      "value": "No"
    },
    "30": {
      "observation_field_id": 109,
      "value": "No"
    },
    "31": {
      "observation_field_id": 110,
      "value": "No"
    },
    "32": {
      "observation_field_id": 99,
      "value": "Not collected"
    },
    "33": {
      "observation_field_id": 100,
      "value": "Not collected"
    },
    "34": {
      "observation_field_id": 101,
      "value": "Not collected"
    },
    "35": {
      "observation_field_id": 200,
      "value": "Not collected"
    },
    "36": {
      "observation_field_id": 114,
      "value": "No"
    },
    "37": {
      "observation_field_id": 82,
      "value": "No"
    },
    "38": {
      "observation_field_id": 83,
      "value": "No"
    },
    "39": {
      "observation_field_id": 84,
      "value": "No"
    },
    "40": {
      "observation_field_id": 85,
      "value": "No"
    },
    "41": {
      "observation_field_id": 86,
      "value": "No"
    },
    "42": {
      "observation_field_id": 94,
      "value": "No"
    },
    "43": {
      "observation_field_id": 87,
      "value": "No"
    },
    "44": {
      "observation_field_id": 88,
      "value": "No"
    },
    "45": {
      "observation_field_id": 89,
      "value": "No"
    },
    "46": {
      "observation_field_id": 90,
      "value": "No"
    },
    "47": {
      "observation_field_id": 91,
      "value": "No"
    },
    "48": {
      "observation_field_id": 92,
      "value": "No"
    },
    "49": {
      "observation_field_id": 93,
      "value": "No"
    },
    "50": {
      "observation_field_id": 95,
      "value": "No"
    },
    "51": {
      "observation_field_id": 96,
      "value": "No"
    },
    "52": {
      "observation_field_id": 97,
      "value": "No"
    }
  },
  "description": null,
  "captive_flag": false,
  "geoprivacy": "obscured",
  "uuid": "${theUuid}"
}
HEREDOC
