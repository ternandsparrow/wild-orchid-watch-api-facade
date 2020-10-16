#!/usr/bin/env python
import os
import requests

client_api_key = os.environ.get('API_KEY')
if not client_api_key:
    raise ValueError('Env var API_KEY must be supplied')


def main():
    page_size = 3
    page = 1
    max_pages = 3
    is_more_pages = True
    while is_more_pages:
        params = {'per_page': page_size, 'page': page}
        headers = {'Authorization': client_api_key}
        print('Processing page %d' % page)
        resp = requests.get('https://api-facade.wildorchidwatch.org/wow-observations',
                params=params, headers=headers)
        if resp.status_code != 200:
            raise ValueError('Failed to make HTTP call for page=%d, status=%d'
                    % (page, resp.status_code))
        json_body = resp.json()
        total_results = json_body['total_results']
        for curr in json_body['results']:
            print('ID=%d' % curr['id'])
            # all observations submitted via the app will be obscured but users are
            # free to add observations using other clients and these may not be
            # obscured.
            priv_loc = curr['private_location'] # also see private_geojson for atomised data
            loc = priv_loc if curr['obscured'] else curr['location']
            print('  datetime=%s' % curr['time_observed_at'])
            print('  location=%s' % loc)
            print('  species=%s' % curr['species_guess'])
            obs_fields = ['%s=%s' % (x['name'], x['value']) for x in curr['ofvs']]
            for v in obs_fields[:2]: # only showing some of the values
                print('  %s' % v)
        is_more_pages = page < max_pages and page * page_size < total_results
        page += 1


main()
