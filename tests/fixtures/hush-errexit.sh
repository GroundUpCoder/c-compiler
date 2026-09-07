sh -ec 'i=0; while [ $i -lt 1 ]; do i=1; done; echo WHILE-OK'; echo WHILE-RC=$?
sh -ec 'i=0; until [ $i -eq 1 ]; do i=1; done; echo UNTIL-OK'; echo UNTIL-RC=$?
sh -ec 'i=0; while false; [ $i -lt 1 ]; do i=1; done; echo MULTI-OK'; echo MULTI-RC=$?
sh -ec 'until false; true; do echo WRONG; done; echo UNTIL-MULTI-OK'; echo UNTIL-MULTI-RC=$?
sh -ec 'while true; do false; echo WRONG; done; echo WRONG'; echo BODY-RC=$?
sh -ec 'until false; do false; echo WRONG; done; echo WRONG'; echo UNTIL-BODY-RC=$?
sh -ec 'if false; then echo WRONG; fi; echo IF-OK'; echo IF-RC=$?
sh -ec 'while false; do echo WRONG; done; false; echo WRONG'; echo AFTER-RC=$?
